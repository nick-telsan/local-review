import { afterAll, beforeAll, expect } from "bun:test";
import { join } from "node:path";
import type { StatusOk } from "../src/commands/status.ts";
import { lr, lrJson } from "../test/lr.ts";
import { closeBrowser, expectTexts, flow, openBrowser } from "./harness.ts";

beforeAll(openBrowser, 30_000);
afterAll(closeBrowser);

flow("replies to a thread, resolves it and reopens it, hearing the agent live", async (ui) => {
  const { page, repo, c1 } = ui;
  const file = join(repo.tmp, "review.json");
  const comments = [{ change: c1, path: "db.ts", lines: [2, 2], body: "Why b?" }];
  await Bun.write(file, JSON.stringify({ verdict: "changes_requested", comments }));
  expect((await lr(repo, "review", "submit", "-F", file, "--as", "human:nick")).err).toBe("");

  await ui.open(`/f/feat/r/1/c/${c1}`);
  const thread = page.getByRole("article", { name: /^Thread #/ }).filter({ hasText: "Why b?" });
  const status = (s: string) => expectTexts(thread.getByTestId("thread-status"), [s]);
  await status("open");

  // The agent answers from the CLI; the open page hears it without a reload.
  const id = (await thread.getAttribute("aria-label"))!.slice("Thread #".length);
  const addressed = await lr(
    repo,
    "reply",
    id,
    "--addressed",
    "Dropped b.",
    "--as",
    "agent:claude",
  );
  expect(addressed.err).toBe("");
  await status("addressed");
  await thread.getByText("marked this addressed").waitFor();
  await thread.getByText("Dropped b.").waitFor();

  await thread.getByRole("button", { name: "Reply…" }).click();
  await thread.getByRole("textbox", { name: "Reply" }).fill("Thanks, that reads better.");
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  await thread.getByText("Thanks, that reads better.").waitFor();
  await thread.getByRole("button", { name: "Resolve" }).click();
  await status("resolved");
  await thread.getByRole("button", { name: "Reopen" }).click();
  await status("open");

  const { data } = await lrJson<StatusOk>(repo, "status");
  const t = data.threads.find((x) => String(x.id) === id)!;
  expect(t.status).toBe("open");
  expect(t.entries.map((e) => [e.author.kind, e.statusChange?.to ?? null, e.body])).toEqual([
    ["human", null, "Why b?"],
    ["agent", "addressed", "Dropped b."],
    ["human", null, "Thanks, that reads better."],
    ["human", "resolved", ""],
    ["human", "open", ""],
  ]);
});
