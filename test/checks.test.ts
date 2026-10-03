import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CheckSettings,
  checkTargets,
  checkWorkspaceDescription,
  runChecks,
} from "../src/checks.ts";
import type { CheckConfig } from "../src/config.ts";
import { LrError } from "../src/errors.ts";
import { Jj } from "../src/jj.ts";
import type { ChangeSnapshot } from "../src/model.ts";
import { parsePlan } from "../src/plan.ts";
import { takeSnapshot } from "../src/snapshot.ts";
import { Store } from "../src/store.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";

const { phases } = parsePlan(TWO_PHASE_PLAN, "feat");

const change = (id: string, bookmarks: string[] = [], empty = false): ChangeSnapshot => ({
  changeId: id,
  commitId: `commit-${id}`,
  description: id,
  trailers: [],
  phaseId: null,
  bookmarks,
  conflicted: false,
  empty,
  stats: { files: 0, added: 0, removed: 0 },
});

const check = (name: string, at: CheckConfig["at"]): CheckConfig => ({
  name,
  run: "true",
  at,
  timeoutMs: 1000,
  killAfterMs: 1000,
});

describe("checkTargets", () => {
  const changes = [
    change("a"),
    change("b", ["feat/1-schema", "unrelated"]),
    change("c", [], true),
    change("d", ["feat/2-rotation"]),
  ];
  const targets = (c: CheckConfig) =>
    checkTargets([c], changes, phases).map((t) => t.change.changeId);

  test("tip is the last change", () => {
    expect(targets(check("x", "tip"))).toEqual(["d"]);
  });

  test("bookmarks are changes carrying a phase bookmark", () => {
    expect(targets(check("x", "bookmarks"))).toEqual(["b", "d"]);
  });

  test("changes are all non-empty changes", () => {
    expect(targets(check("x", "changes"))).toEqual(["a", "b", "d"]);
  });

  test("targets are ordered by stack position, then check", () => {
    const pairs = checkTargets([check("t", "tip"), check("b", "bookmarks")], changes, phases).map(
      (t) => `${t.check.name}@${t.change.changeId}`,
    );
    expect(pairs).toEqual(["b@b", "t@d", "b@d"]);
  });
});

describe("runChecks", () => {
  let repo: TestRepo;
  let store: Store;

  beforeEach(async () => {
    repo = await TestRepo.create();
    await repo.commit("base", { "README.md": "hello\n" });
    await repo.bookmark("main");
    await repo.commit("Add table", { "schema.sql": "good\n" });
    await repo.bookmark("feat/1-schema");
    await repo.commit("Rotate", { "rotate.ts": "x\n" });
    await repo.bookmark("feat/2-rotation");
    store = await Store.open(repo.root);
    store.createFeature({ slug: "feat", title: "Feat", baseRevset: "main" });
  });

  afterEach(() => {
    store.close();
    repo.cleanup();
  });

  // What lr printed while running checks.
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
  });

  const run = async (config: CheckSettings) => {
    const jj = new Jj(repo.root);
    const snap = await takeSnapshot(jj, "main", phases);
    const featureDir = join(repo.tmp, "feature");
    const results = await runChecks({
      jj,
      store,
      slug: "feat",
      featureDir,
      config,
      targets: checkTargets(config.checks, snap.changes, phases),
      trigger: "auto",
      log: (line) => lines.push(line),
    });
    return { results, featureDir };
  };

  test("runs in a separate workspace and reuses passing results", async () => {
    const config: CheckSettings = {
      setup: "touch setup-ran",
      setupKillAfterMs: 1000,
      checks: [
        {
          name: "has-schema",
          run: "test -f schema.sql && touch dirty",
          at: "bookmarks",
          timeoutMs: 5000,
          killAfterMs: 1000,
        },
      ],
    };
    const first = await run(config);
    expect(first.results.map((r) => [r.run.status, r.cached])).toEqual([
      ["pass", false],
      ["pass", false],
    ]);
    // Neither the check's nor setup's files leak into the developer's working copy or history.
    expect(existsSync(join(repo.root, "dirty"))).toBe(false);
    expect(existsSync(join(first.featureDir, "workspaces", "checks", "dirty"))).toBe(false);
    const files = await repo.jj("log", "--no-graph", "-r", "all()", "-T", "self.diff().summary()");
    expect(files).not.toContain("dirty");
    expect(files).not.toContain("setup-ran");

    const second = await run(config);
    expect(second.results.map((r) => [r.run.id, r.cached])).toEqual(
      first.results.map((r) => [r.run.id, true]),
    );
  });

  test("a changed command isn't served from cache", async () => {
    const pass = (run: string): CheckSettings => ({
      setup: null,
      setupKillAfterMs: 1000,
      checks: [{ name: "c", run, at: "tip", timeoutMs: 5000, killAfterMs: 1000 }],
    });
    await run(pass("true"));
    const again = await run(pass("true "));
    expect(again.results.map((r) => r.cached)).toEqual([false]);
  });

  test("recreates the workspace if its directory was deleted", async () => {
    const config: CheckSettings = {
      setup: null,
      setupKillAfterMs: 1000,
      checks: [{ name: "c", run: "exit 1", at: "tip", timeoutMs: 5000, killAfterMs: 1000 }],
    };
    const { featureDir } = await run(config);
    await Bun.$`rm -rf ${join(featureDir, "workspaces")}`;
    const again = await run(config);
    expect(again.results.map((r) => r.run.status)).toEqual(["fail"]);
  });

  describe("the workspace's commit", () => {
    const config = (at: CheckConfig["at"]): CheckSettings => ({
      setup: null,
      setupKillAfterMs: 1000,
      checks: [{ name: "c", run: "true", at, timeoutMs: 5000, killAfterMs: 1000 }],
    });
    /** Every commit lr's description is on, as `<change id> <parent's description>`. */
    const parked = async () =>
      (
        await repo.jj(
          "log",
          "--no-graph",
          "-r",
          `description(substring:${JSON.stringify(checkWorkspaceDescription("feat"))})`,
          "-T",
          'change_id ++ " " ++ parents.map(|p| p.description().first_line()) ++ "\n"',
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean);

    test("is described as lr's, and moves instead of piling up", async () => {
      await run(config("bookmarks"));
      const [first] = await parked();
      expect(first).toEndWith(" Rotate");
      const wc = await repo.jj("log", "--no-graph", "-r", '"lr-feat-checks"@', "-T", "description");
      expect(wc.trim()).toBe(checkWorkspaceDescription("feat"));

      await repo.commit("Rotate more", { "rotate.ts": "y\n" });
      await repo.bookmark("feat/2-rotation");
      await run(config("tip"));
      expect(await parked()).toEqual([`${first!.split(" ")[0]} Rotate more`]);
    });

    test("doesn't outlive a workspace whose directory was deleted", async () => {
      const { featureDir } = await run(config("tip"));
      await Bun.$`rm -rf ${join(featureDir, "workspaces")}`;
      await run(config("tip"));
      expect(await parked()).toHaveLength(1);
    });

    test("is described in a workspace made before lr described it", async () => {
      const dir = join(repo.tmp, "feature", "workspaces", "checks");
      mkdirSync(join(dir, ".."), { recursive: true });
      await repo.jj("workspace", "add", "--name", "lr-feat-checks", "-r", "root()", dir);
      await run(config("tip"));
      expect(await parked()).toHaveLength(1);
    });
  });

  const lockFile = () => join(repo.tmp, "feature", "workspaces", "checks.lock");

  describe("the checks workspace lock", () => {
    test("a second run waits for the first, then reuses what it passed", async () => {
      const started = join(repo.tmp, "started");
      const go = join(repo.tmp, "go");
      const config: CheckSettings = {
        setup: null,
        setupKillAfterMs: 1000,
        checks: [
          {
            name: "slow",
            run: `echo x >> ${started}; while [ ! -f ${go} ]; do sleep 0.05; done`,
            at: "tip",
            timeoutMs: 10_000,
            killAfterMs: 1000,
          },
        ],
      };
      const first = run(config);
      while (!existsSync(started)) await Bun.sleep(20);
      const second = run(config);
      while (!lines.some((l) => l.startsWith("waiting for another lr"))) await Bun.sleep(20);
      expect(lines.find((l) => l.startsWith("waiting"))).toMatch(
        new RegExp(
          `^waiting for another lr \\(pid ${process.pid}, running checks since .+\\) to finish with the checks workspace$`,
        ),
      );

      await Bun.write(go, "");
      const [a, b] = await Promise.all([first, second]);
      expect(a.results.map((r) => [r.run.status, r.cached])).toEqual([["pass", false]]);
      expect(b.results.map((r) => [r.run.id, r.cached])).toEqual([[a.results[0]!.run.id, true]]);
      expect(await Bun.file(started).text()).toBe("x\n");
      expect(existsSync(lockFile())).toBe(false);
    });

    test("a lock left by a process that's gone is taken over", async () => {
      const dead = Bun.spawn(["true"]);
      await dead.exited;
      mkdirSync(join(repo.tmp, "feature", "workspaces"), { recursive: true });
      writeFileSync(lockFile(), JSON.stringify({ pid: dead.pid, startedAt: "then" }));
      const r = await run({
        setup: null,
        setupKillAfterMs: 1000,
        checks: [check("c", "tip")],
      });
      expect(r.results.map((x) => x.run.status)).toEqual(["pass"]);
      expect(lines.some((l) => l.startsWith("waiting"))).toBe(false);
      expect(existsSync(lockFile())).toBe(false);
    });
  });

  describe("stopping checks", () => {
    // Each command records its process group (its shell's pid), to check nothing outlives it.
    const pgidFile = () => join(repo.tmp, "pgid");
    const one = (run: string, timeoutMs = 5000, killAfterMs = 30_000): CheckSettings => ({
      setup: null,
      setupKillAfterMs: 30_000,
      checks: [
        { name: "c", run: `echo $$ > ${pgidFile()}; ${run}`, at: "tip", timeoutMs, killAfterMs },
      ],
    });
    const groupGone = async () => {
      const pgid = Number(await Bun.file(pgidFile()).text());
      expect(() => process.kill(-pgid, 0)).toThrow();
    };
    const log = (r: { results: { run: { logPath: string } }[] }) =>
      Bun.file(r.results[0]!.run.logPath).text();
    const waited = () => lines.filter((l) => l.includes("waiting up to"));

    test("a timeout stops everything the check started", async () => {
      const started = Date.now();
      const r = await run(one("sleep 30 & sleep 30", 300));
      expect(r.results.map((x) => x.run.status)).toEqual(["error"]);
      expect(await log(r)).toContain("[lr] timed out after 300ms; stopped with SIGTERM");
      expect(Date.now() - started).toBeLessThan(5000);
      // It exited right away, so there was no wait to mention.
      expect(waited()).toEqual([]);
      await groupGone();
    });

    test("SIGKILL when the check outlasts kill_after, saying what lr is waiting for", async () => {
      const r = await run(one("trap '' TERM; sleep 30", 200, 800));
      expect(waited()).toEqual([
        "  c: timed out after 200ms; waiting up to 800ms for it to stop (Ctrl-C to kill it now)",
      ]);
      expect(await log(r)).toContain("stopped with SIGKILL");
      await groupGone();
    });

    test("processes a passing check leaves behind are stopped", async () => {
      const r = await run(one("sleep 30 & true"));
      expect(r.results.map((x) => x.run.status)).toEqual(["pass"]);
      expect(await log(r)).toContain("[lr] stopped processes it left running (SIGTERM)");
      await groupGone();
    });

    test("leftovers that take a while to stop", async () => {
      const r = await run(one("(trap '' TERM; sleep 30) & true", 5000, 700));
      expect(r.results.map((x) => x.run.status)).toEqual(["pass"]);
      expect(waited()).toEqual([
        "  c: stopping what it left running; waiting up to 700ms for it to stop (Ctrl-C to kill it now)",
      ]);
      expect(await log(r)).toContain("[lr] stopped processes it left running (SIGKILL)");
      await groupGone();
    });

    /** Run checks, and send lr `signals` once `ready` (by default: once the check started). */
    async function interrupt(
      settings: CheckSettings,
      signals: NodeJS.Signals[],
      ready = () => existsSync(pgidFile()),
    ) {
      const running = run(settings).catch((e: unknown) => e);
      while (!ready()) await Bun.sleep(20);
      for (const signal of signals) {
        process.emit(signal, signal);
        await Bun.sleep(100);
      }
      return (await running) as LrError;
    }

    test("Ctrl-C stops the check and the round", async () => {
      const listeners = process.listenerCount("SIGINT");
      const e = await interrupt(one("sleep 30"), ["SIGINT"]);
      expect(e).toBeInstanceOf(LrError);
      expect(e.message).toBe("checks interrupted by SIGINT");
      expect(e.exitCode).toBe(130);
      await groupGone();
      const row = store.db.query("SELECT status, log_path FROM check_runs").get() as {
        status: string;
        log_path: string;
      };
      expect(row.status).toBe("error");
      expect(await Bun.file(row.log_path).text()).toContain("[lr] interrupted by SIGINT");
      expect(existsSync(lockFile())).toBe(false);
      // lr stops listening once the check is over.
      expect(process.listenerCount("SIGINT")).toBe(listeners);
    });

    test("a second Ctrl-C kills a check that ignores the first", async () => {
      const e = await interrupt(one("trap '' INT; sleep 30"), ["SIGINT", "SIGINT"]);
      expect(e.exitCode).toBe(130);
      await groupGone();
    });

    test("Ctrl-C while lr waits for a timed-out check kills it now", async () => {
      const started = Date.now();
      const settings = one("trap '' TERM; sleep 30", 200, 30_000);
      const e = await interrupt(settings, ["SIGINT"], () => waited().length > 0);
      expect(e.exitCode).toBe(130);
      expect(Date.now() - started).toBeLessThan(5000);
      await groupGone();
    });

    test("an interrupted setup stops the round", async () => {
      const e = await interrupt(
        {
          setup: `echo $$ > ${pgidFile()}; sleep 30`,
          setupKillAfterMs: 30_000,
          checks: [check("c", "tip")],
        },
        ["SIGTERM"],
      );
      expect(e.exitCode).toBe(143);
      expect(store.db.query("SELECT * FROM check_runs").all()).toEqual([]);
    });
  });
});
