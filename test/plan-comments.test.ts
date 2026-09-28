import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ThreadsOk } from "../src/commands/thread.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson, lrWithStdin } from "./lr.ts";

// The plan file's lines: 8 is task 1.2 ("Backfill"), 13 "# Plan", 15 "Body."
let repo: TestRepo;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  await repo.commit("Add db", { "db.ts": "a\n" });
  await repo.bookmark("feat/1-schema");
  await repo.commit("Rotate", { "rotate.ts": "r\n" });
  await repo.bookmark("feat/2-rotation");
  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
  expect((await lr(repo, "review", "create")).code).toBe(0);
});

afterEach(() => repo.cleanup());

const submit = (comments: object[]) =>
  lrWithStdin(
    repo,
    JSON.stringify({ verdict: "changes_requested", comments }),
    "review",
    "submit",
    "-F",
    "-",
    "--as",
    "human:nick",
  );

const threads = async () =>
  (await lrJson<ThreadsOk>(repo, "threads", "--all")).data.threads.map((t) => ({
    id: t.id,
    state: t.anchorState,
    round: t.anchorRound,
    anchor: t.anchor,
  }));

test("comments on the plan's lines, checked against the round's plan", async () => {
  const shape = await submit([{ plan: true, change: "zzzz", body: "?" }]);
  expect(shape.err).toContain("comments[0]: plan comments stand alone");
  const range = await submit([{ plan: true, lines: [99, 99], body: "?" }]);
  expect(range.err).toContain("comments[0]: lines 99-99 are past the end of plan v1 (15 lines)");

  const ok = await submit([
    { plan: true, lines: [15, 15], severity: "blocking", body: "Say more." },
    { plan: true, lines: 8, body: "Why backfill?" },
    { plan: true, body: "On the whole plan." },
  ]);
  expect(ok.err).toBe("");
  expect(await threads()).toEqual([
    {
      id: 1,
      state: "current",
      round: 1,
      anchor: { kind: "plan", version: 1, lines: [15, 15], snippet: ["Body."] },
    },
    {
      id: 2,
      state: "current",
      round: 1,
      anchor: {
        kind: "plan",
        version: 1,
        lines: [8, 8],
        snippet: ['      - { id: "1.2", title: Backfill }'],
      },
    },
    expect.objectContaining({ id: 3, anchor: expect.objectContaining({ lines: null }) }),
  ]);

  const handoff = (await lr(repo, "handoff")).out;
  expect(handoff).toContain("## The plan\n");
  expect(handoff).toContain("### #1 · blocking · plan v1, line 15\n\n```\nBody.\n```");
  expect(handoff).toContain("### #3 · plan v1\n\n> **human:nick**: On the whole plan.");
});

test("a revised plan carries them: kept, moved, or outdated", async () => {
  await submit([
    { plan: true, lines: [15, 15], body: "Say more." },
    { plan: true, lines: [8, 8], body: "Why backfill?" },
    { plan: true, body: "On the whole plan." },
  ]);
  const v2 = TWO_PHASE_PLAN.replace("# Plan\n", "# Plan\n\nIntro.\n");
  expect((await lrWithStdin(repo, v2, "plan", "revise", "-F", "-")).code).toBe(0);
  expect((await lr(repo, "review", "create")).code).toBe(0);

  const [body, task, whole] = await threads();
  expect(body).toMatchObject({ state: "moved", round: 2, anchor: { version: 2, lines: [17, 17] } });
  expect(task).toMatchObject({ state: "current", round: 2, anchor: { version: 2, lines: [8, 8] } });
  // Any change to the plan outdates a comment on all of it; it stays where it was made.
  expect(whole).toMatchObject({ state: "outdated", round: 1, anchor: { version: 1 } });
});
