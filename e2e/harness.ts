// Browser tests: each flow drives the real UI in headless Chromium, against a real jj repo and an
// `lr ui` server running in the test process.
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright-core";
import { Context } from "../src/context.ts";
import { startUi, type UiServer } from "../src/ui/server.ts";
import { TestRepo, TWO_PHASE_PLAN } from "../test/helpers.ts";
import { lr } from "../test/lr.ts";

/** Where a failing flow's trace goes; open one with `bunx playwright-core show-trace <file>`. */
export const RESULTS = join(import.meta.dir, "results");

/** How long a flow, and a Playwright action or wait, may take. */
const FLOW_MS = 30_000;
const ACTION_MS = 5_000;

let browser: Browser | null = null;

/** Launch the browser, in a test file's `beforeAll`. */
export async function openBrowser(): Promise<void> {
  try {
    browser = await chromium.launch();
  } catch (e) {
    if (String(e).includes("Executable doesn't exist")) {
      throw new Error("No browser for the e2e tests; install it with `bun run e2e:install`");
    }
    throw e;
  }
}

/** Close the browser, in a test file's `afterAll`. */
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

export interface Ui {
  repo: TestRepo;
  /** The change in phase 1 (adds db.ts, by default) and the one in phase 2 (adds rotate.ts). */
  c1: string;
  c2: string;
  page: Page;
  server: UiServer;
  /** Go to a path of the UI, e.g. `/f/feat/r/1`. */
  open(path?: string): Promise<void>;
}

export interface FlowOptions {
  /** The two changes' messages, e.g. to give one a `Plan-Task` trailer. */
  messages?: [string, string];
  /** The files each change adds, in place of `db.ts` and `rotate.ts`. */
  files?: [Record<string, string>, Record<string, string>];
}

/**
 * A test that opens the UI on a fresh stack: `main` with a README, a change in each of
 * `TWO_PHASE_PLAN`'s phases, and feature `feat` with plan v1 and round 1. The page acts as
 * `human:nick`. The flow fails on any error the page throws or logs, and leaves a trace in
 * `e2e/results/` when it fails.
 */
export function flow(name: string, fn: (ui: Ui) => Promise<void>, opts: FlowOptions = {}): void {
  test(
    name,
    async () => {
      const [m1, m2] = opts.messages ?? ["Add db\n\nWith a body.", "Rotate"];
      const [f1, f2] = opts.files ?? [{ "db.ts": "a\nb\nc\n" }, { "rotate.ts": "r1\nr2\n" }];
      const repo = await TestRepo.create();
      await repo.commit("base", { "README.md": "hello\n" });
      await repo.bookmark("main");
      const c1 = await repo.commit(m1, f1);
      await repo.bookmark("feat/1-schema");
      const c2 = await repo.commit(m2, f2);
      await repo.bookmark("feat/2-rotation");
      await lr(repo, "feature", "start", "feat", "--base", "main");
      await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
      await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
      const created = await lr(repo, "review", "create");
      if (created.code !== 0) throw new Error(`lr review create failed: ${created.err}`);

      const silent = { out: () => {}, err: () => {}, stdin: async () => "" };
      const ctx = (await Context.create({ repo: repo.root }, silent)).with({
        actor: { kind: "human", name: "nick" },
      });
      const server = startUi(ctx);
      let context: BrowserContext | null = null;
      let failed = false;
      // What the page threw or logged as an error: often why a flow then times out.
      const errors: string[] = [];
      const reported = () => `The page reported errors:\n${errors.join("\n")}`;
      try {
        if (!browser) throw new Error("call openBrowser() in the file's beforeAll");
        context = await browser.newContext();
        context.setDefaultTimeout(ACTION_MS);
        await context.tracing.start({ screenshots: true, snapshots: true });
        const page = await context.newPage();
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });

        // The first page load takes the token, as the link `lr ui` prints does.
        let first = true;
        const open = async (path = "/") => {
          const url = new URL(path, server.url);
          if (first) url.searchParams.set("t", server.token);
          first = false;
          await page.goto(url.href);
        };
        try {
          await fn({ repo, c1, c2, page, server, open });
        } catch (e) {
          if (errors.length && e instanceof Error) e.message += `\n\n${reported()}`;
          throw e;
        }
        if (errors.length) throw new Error(reported());
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        if (context) {
          const path = failed ? join(RESULTS, `${traceName(name)}.zip`) : undefined;
          if (path) mkdirSync(RESULTS, { recursive: true });
          await context.tracing.stop({ path });
          await context.close();
          if (path) console.error(`Trace: ${path}`);
        }
        await server.stop();
        ctx.close();
        repo.cleanup();
      }
    },
    FLOW_MS,
  );
}

/** The flow's name, as a file name. */
function traceName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").slice(0, 120);
}

/**
 * Wait until `locator`'s elements have exactly `texts`, like Playwright's `toHaveText`; `bun:test`'s
 * `expect` doesn't retry. Fails with the texts it last saw.
 */
export async function expectTexts(locator: Locator, texts: string[]): Promise<void> {
  const until = Date.now() + ACTION_MS;
  let seen = await locator.allTextContents();
  while (!Bun.deepEquals(seen, texts) && Date.now() < until) {
    await Bun.sleep(50);
    seen = await locator.allTextContents();
  }
  expect(seen).toEqual(texts);
}

/** Wait until `ok` holds, failing with `what` after a while. */
export async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + ACTION_MS;
  while (!(await ok())) {
    if (Date.now() > until) throw new Error(`Timed out waiting until ${what}`);
    await Bun.sleep(50);
  }
}

/**
 * Write `body` in the open comment form (with a severity, if given) and add it to the review.
 * Returns the draft, once it shows.
 */
export async function addComment(page: Page, body: string, severity?: string): Promise<Locator> {
  await page.getByRole("textbox", { name: "Comment" }).fill(body);
  // The radios hide behind their labels, which are what a person clicks.
  if (severity) {
    await page
      .getByRole("group", { name: "Severity" })
      .getByText(severity, { exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Add to review" }).click();
  const draft = page.getByRole("article", { name: "Draft comment" }).filter({ hasText: body });
  await draft.waitFor();
  return draft;
}
