import { afterAll, beforeAll, expect } from "bun:test";
import type { StatusOk } from "../src/commands/status.ts";
import { lr, lrJson, lrWithStdin } from "../test/lr.ts";
import { addComment, closeBrowser, expectTexts, flow, openBrowser } from "./harness.ts";

beforeAll(openBrowser, 30_000);
afterAll(closeBrowser);

const PR_BODY = "## Summary\n\nToken rotation.\n\n## Testing\n\nbun test\n";

flow("reviews a final round's commit messages and PR body, then approves it", async (ui) => {
  const { page, repo } = ui;
  const nick = ["--as", "human:nick"];
  expect((await lr(repo, "review", "submit", "--verdict", "approved", ...nick)).err).toBe("");
  const drafts = [
    ["final", "message", "1", "Add the db\n\nWith a body."],
    ["final", "message", "2", "Rotate tokens on use"],
    ["final", "pr-body", PR_BODY],
  ];
  for (const args of drafts) {
    const text = args.pop()!;
    expect((await lrWithStdin(repo, text, ...args, "-F", "-")).err).toBe("");
  }
  expect((await lr(repo, "review", "create", "--final")).code).toBe(0);

  await ui.open("/f/feat");
  await page.getByRole("link", { name: "Final 2" }).waitFor();
  await page.getByText("Final round 2 · open").waitFor();
  const commits = page.getByRole("region", { name: "Final commits" });
  await expectTexts(commits.getByRole("heading", { level: 3 }), [
    "Commit 1 · squashes Add db",
    "Commit 2 · squashes Rotate",
  ]);
  await expectTexts(commits.getByTestId("line-text"), [
    "Add the db",
    "",
    "With a body.",
    "Rotate tokens on use",
  ]);

  // A comment on a line of the PR body, then the body read rendered, with the comment below.
  const pr = page.getByRole("region", { name: "PR body" });
  await pr.getByRole("button", { name: "Line 3", exact: true }).click();
  await addComment(page, "Say what it rotates.", "suggestion");
  await pr
    .getByRole("group", { name: "How to show it" })
    .getByRole("button", { name: "Preview" })
    .click();
  await pr.getByRole("heading", { name: "Testing" }).waitFor();
  await pr.getByRole("article", { name: "Draft comment" }).getByText("line 3").waitFor();

  await page.getByRole("button", { name: /^Finish review/ }).click();
  const panel = page.getByRole("dialog", { name: "Finish your review" });
  await panel.getByRole("textbox", { name: "Summary" }).fill("Ship it.");
  await panel.getByRole("group", { name: "Verdict" }).getByText("Approve", { exact: true }).click();
  await panel.getByText("Ready to apply the final commits").waitFor();
  await panel.getByRole("button", { name: "Submit review" }).click();
  await page.getByRole("listitem").filter({ hasText: "Ship it." }).getByText("approved").waitFor();

  const { data } = await lrJson<StatusOk>(repo, "status");
  expect(data.round).toMatchObject({ n: 2, kind: "final" });
  expect(data.reviews.map((r) => r.verdict)).toEqual(["approved"]);
  const thread = data.threads.find((t) => t.anchor.kind === "pr_body")!;
  expect(thread.anchor).toMatchObject({ lines: [3, 3], snippet: ["Token rotation."] });
  expect(thread.severity).toBe("suggestion");
});
