import { afterAll, beforeAll, expect } from "bun:test";
import { join } from "node:path";
import { lr } from "../test/lr.ts";
import { closeBrowser, expectTexts, flow, openBrowser } from "./harness.ts";

beforeAll(openBrowser, 30_000);
afterAll(closeBrowser);

flow("shows what changed since the last review", async (ui) => {
  const { page, repo, c1 } = ui;
  // Round 1 reviewed; round 2 capitalizes db.ts's "b", in the first change.
  const file = join(repo.tmp, "review.json");
  const comments = [{ change: c1, path: "db.ts", lines: [2, 2], body: "Capitalize." }];
  await Bun.write(file, JSON.stringify({ verdict: "changes_requested", comments }));
  expect((await lr(repo, "review", "submit", "-F", file, "--as", "human:nick")).err).toBe("");
  await repo.write("db.ts", "a\nB\nc\n");
  await repo.jj("squash", "--into", c1);
  expect((await lr(repo, "review", "create")).code).toBe(0);

  await ui.open("/f/feat/r/2");
  const bar = page.getByRole("group", { name: "What to show" });
  await bar.getByRole("button", { name: "Whole round", pressed: true }).waitFor();
  await page.getByText("1 changed, 1 unchanged").waitFor();
  await bar.getByRole("button", { name: "Since your last review (round 1)" }).click();
  await page.waitForURL(/\?since=1$/);

  const stack = page.getByRole("navigation", { name: "Stack" });
  const db = stack.getByRole("link", { name: /Add db/ });
  await db.getByText("changed", { exact: true }).waitFor();
  await stack
    .getByRole("link", { name: /Rotate/ })
    .getByText("same", { exact: true })
    .waitFor();

  // The changed change shows its interdiff, which takes comments on its new side only.
  await db.click();
  await page.waitForURL(new RegExp(`/c/${c1}\\?since=1$`));
  await page.getByText("Changed since round 1.").waitFor();
  const diff = page.getByRole("region", { name: "db.ts" });
  await expectTexts(diff.getByTestId("line-text"), [" a", "−b", "+B", " c"]);
  await diff.getByRole("button", { name: "New line 2" }).waitFor();
  expect(await diff.getByRole("button", { name: /^Old line/ }).count()).toBe(0);

  // Back to the whole round: the change's whole diff.
  await bar.getByRole("button", { name: "Whole round" }).click();
  await page.waitForURL(new RegExp(`/c/${c1}$`));
  await page.getByRole("heading", { name: "Files (1)" }).waitFor();
  await expectTexts(diff.getByTestId("line-text"), ["+a", "+B", "+c"]);
});
