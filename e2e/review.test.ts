import { afterAll, beforeAll, expect } from "bun:test";
import type { StatusOk } from "../src/commands/status.ts";
import { lrJson } from "../test/lr.ts";
import { addComment, closeBrowser, flow, openBrowser } from "./harness.ts";

beforeAll(openBrowser, 30_000);
afterAll(closeBrowser);

flow("drafts comments across the round, then requests changes", async (ui) => {
  const { page, c1 } = ui;
  const stack = page.getByRole("navigation", { name: "Stack" });
  await ui.open(`/f/feat/r/1/c/${c1}`);

  // A line of the diff, and a line of the commit message ("With a body.").
  await page
    .getByRole("region", { name: "db.ts" })
    .getByRole("button", { name: "New line 2" })
    .click();
  await page.getByText("Line 2 · shift-click").waitFor();
  await addComment(page, "Why b?", "blocking");
  await page.getByRole("button", { name: "Line 3", exact: true }).click();
  await addComment(page, "Say what the body is for.");

  await stack.getByRole("link", { name: /^Plan/ }).click();
  await page.getByRole("button", { name: "+ Comment on the whole plan" }).click();
  await addComment(page, "Phase 2 has no tasks.");

  // On the overview: two general comments, one edited and one deleted.
  await stack.getByRole("link", { name: "Overview" }).click();
  for (const body of ["Close.", "Never mind."]) {
    await page.getByRole("button", { name: "+ Add a general comment" }).click();
    await addComment(page, body);
  }
  const drafts = page.getByRole("article", { name: "Draft comment" });
  await drafts.filter({ hasText: "Never mind." }).getByRole("button", { name: "Delete" }).click();
  await drafts.filter({ hasText: "Never mind." }).waitFor({ state: "detached" });
  await drafts.filter({ hasText: "Close." }).getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Comment" }).fill("Close, with one question.");
  await page.getByRole("button", { name: "Save" }).click();
  await drafts.filter({ hasText: "Close, with one question." }).waitFor();

  await page.getByRole("button", { name: /^Finish review/ }).click();
  const panel = page.getByRole("dialog", { name: "Finish your review" });
  await panel.getByText("4 drafted comments will be submitted with it.").waitFor();
  await panel.getByRole("textbox", { name: "Summary" }).fill("A few things.");
  await panel.getByRole("group", { name: "Verdict" }).getByText("Request changes").click();
  await panel.getByRole("button", { name: "Submit review" }).click();
  await panel.waitFor({ state: "detached" });

  // The round shows the review and its threads, and so does `lr status`.
  const review = page.getByRole("listitem").filter({ hasText: "A few things." });
  await review.getByText("changes requested").waitFor();
  await page
    .getByRole("article", { name: /^Thread #/ })
    .filter({ hasText: "Close, with one question." })
    .waitFor();
  expect(await drafts.count()).toBe(0);

  const { data } = await lrJson<StatusOk>(ui.repo, "status");
  expect(data.reviews.map((r) => [r.reviewer, r.verdict, r.body])).toEqual([
    [{ kind: "human", name: "nick" }, "changes_requested", "A few things."],
  ]);
  const threads = data.threads.map((t) => ({
    on: t.anchor.kind,
    body: t.entries[0]!.body,
    severity: t.severity,
    status: t.status,
  }));
  expect(threads).toHaveLength(4);
  expect(threads).toEqual(
    expect.arrayContaining([
      { on: "code", body: "Why b?", severity: "blocking", status: "open" },
      { on: "message", body: "Say what the body is for.", severity: null, status: "open" },
      { on: "plan", body: "Phase 2 has no tasks.", severity: null, status: "open" },
      { on: "feature", body: "Close, with one question.", severity: null, status: "open" },
    ]),
  );
});
