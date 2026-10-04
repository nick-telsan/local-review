import { afterAll, beforeAll, expect } from "bun:test";
import { join } from "node:path";
import { lr } from "../test/lr.ts";
import { closeBrowser, flow, openBrowser } from "./harness.ts";

beforeAll(openBrowser, 30_000);
afterAll(closeBrowser);

flow("moves around and acts with the keyboard", async (ui) => {
  const { page, repo, c1, c2 } = ui;
  const file = join(repo.tmp, "review.json");
  const comments = [{ change: c2, path: "rotate.ts", lines: [1, 1], body: "Why r1?" }];
  await Bun.write(file, JSON.stringify({ verdict: null, comments }));
  expect((await lr(repo, "review", "submit", "-F", file, "--as", "human:nick")).err).toBe("");
  await ui.open("/f/feat/r/1");
  await page.getByRole("heading", { name: "feat", level: 1 }).waitFor();

  // ? lists the shortcuts; Esc closes the list.
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await page.keyboard.press("?");
  await help.getByText("Finish your review").waitFor();
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });

  // j and k step through the overview, the plan, and each change.
  await page.keyboard.press("j");
  await page.waitForURL(/\/r\/1\/plan$/);
  await page.keyboard.press("j");
  await page.waitForURL(new RegExp(`/c/${c1}$`));
  await page.keyboard.press("k");
  await page.waitForURL(/\/r\/1\/plan$/);
  await page.keyboard.press("j");
  await page.waitForURL(new RegExp(`/c/${c1}$`));

  // n finds no thread here, so it goes on to the next change with one, and selects it.
  await page.keyboard.press("n");
  await page.waitForURL(new RegExp(`/c/${c2}$`));
  const thread = page.getByRole("article", { name: /^Thread #/ }).filter({ hasText: "Why r1?" });
  const selected = await thread.elementHandle();
  await page.waitForFunction((el) => el === document.activeElement, selected);

  // r replies to the selected thread; Esc puts the reply away.
  await page.keyboard.press("r");
  const reply = thread.getByRole("textbox", { name: "Reply" });
  await reply.waitFor();
  await page.keyboard.press("Escape");
  await reply.waitFor({ state: "detached" });

  // c comments on the change; f opens the review panel.
  await page.keyboard.press("c");
  const comment = page.getByRole("textbox", { name: "Comment" });
  await comment.waitFor();
  await page.keyboard.press("Escape");
  await comment.waitFor({ state: "detached" });
  await page.keyboard.press("f");
  await page.getByRole("dialog", { name: "Finish your review" }).waitFor();
});
