import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ReviewCreateOk } from "../src/commands/review.ts";
import type { StatusOk } from "../src/commands/status.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson } from "./lr.ts";

// The plan's tasks: 1.1 Add table, 1.2 Backfill (phase 1); phase 2 has none.
let repo: TestRepo;
let c1: string, c2: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Add table\n\nPlan-Task: 1.1, 7.7", { "db.ts": "a\n" });
  await repo.bookmark("feat/1-schema");
  c2 = await repo.commit("Rotate", { "rotate.ts": "r\n" });
  await repo.bookmark("feat/2-rotation");
  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
  expect((await lr(repo, "review", "create")).code).toBe(0);
});

afterEach(() => repo.cleanup());

test("lr status lists the gaps between the plan's tasks and the changes", async () => {
  const { data } = await lrJson<StatusOk>(repo, "status");
  expect(data.planGaps).toEqual([
    { kind: "task", phaseId: 1, taskId: "1.2", title: "Backfill" },
    { kind: "unknown_task", changeId: c1, taskId: "7.7" },
    { kind: "untasked_change", phaseId: 2, changeId: c2 },
  ]);
  expect((await lr(repo, "status")).out).toContain(
    [
      "Plan gaps (Plan-Task trailers vs plan v1):",
      '  task 1.2 "Backfill" (phase 1): no change names it',
      `  ${c1.slice(0, 8)} "Add table" names task 7.7, which the plan doesn't have`,
      `  ${c2.slice(0, 8)} "Rotate" (phase 2) names no task`,
    ].join("\n"),
  );
});

test("the handoff lists them, and says how to close them", async () => {
  await lr(repo, "review", "submit", "--verdict", "changes_requested", "--as", "human:nick");
  const out = (await lr(repo, "handoff")).out;
  expect(out).toContain(
    "## Plan gaps (Plan-Task trailers vs plan v1)\n\n" +
      '- task 1.2 "Backfill" (phase 1): no change names it\n',
  );
  expect(out).toContain("Close the plan gaps listed above");
});

test("no gaps until some change names a task", async () => {
  await repo.jj("describe", c1, "-m", "Add table");
  expect((await lr(repo, "review", "create")).code).toBe(0);
  const { data } = await lrJson<StatusOk>(repo, "status");
  expect(data.planGaps).toEqual([]);
  expect((await lr(repo, "status")).out).not.toContain("Plan gaps");
});

test("lr review create warns about them, without blocking the round", async () => {
  await repo.jj("describe", c2, "-m", "Rotate\n\nPlan-Task: 1.2");
  await repo.jj("new", c1, "-m", "Unrelated\n\nPlan-Task: 1.1");
  await repo.write("x.ts", "x\n");
  await repo.jj("rebase", "-s", c2, "-d", "@");
  await repo.jj("new", "feat/2-rotation");

  const r = await lr(repo, "review", "create");
  expect(r.code).toBe(0);
  expect(r.err).toContain(`warning: plan gap: ${c1.slice(0, 8)} "Add table" names task 7.7`);
  expect(r.out).toContain("Plan gaps: 1 (the warnings above;");

  const { data } = await lrJson<ReviewCreateOk>(repo, "review", "create");
  expect(data.planGaps).toEqual([{ kind: "unknown_task", changeId: c1, taskId: "7.7" }]);
  expect(data.warnings.filter((w) => w.startsWith("plan gap:"))).toHaveLength(1);
});
