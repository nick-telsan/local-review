import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ReviewCreateOk } from "../src/commands/review.ts";
import type { StatusOk } from "../src/commands/status.ts";
import type { Handoff } from "../src/handoff.ts";
import { uiInfoPath } from "../src/ui/running.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson, lrWithStdin } from "./lr.ts";

let repo: TestRepo;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  await repo.commit("Add table", { "db.ts": "a\n" });
  await repo.bookmark("feat/1-schema");
  await repo.commit("Rotate", { "rotate.ts": "r\n" });
  await repo.bookmark("feat/2-rotation");
  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
});

afterEach(() => repo.cleanup());

/** Record a UI as `lr ui` does: this process stands in for a running one. */
const serving = (pid = process.pid) =>
  Bun.write(uiInfoPath(repo.root), JSON.stringify({ pid, port: 4321, token: "secret" }));

const ROUND_1 = "http://127.0.0.1:4321/f/feat/r/1";

test("with lr ui running, review create, status, and the handoff link to the round", async () => {
  await serving();
  const created = await lr(repo, "review", "create");
  expect(created.out).toContain(`Review it in the browser: ${ROUND_1}`);
  expect(created.out).not.toContain("secret");
  await lr(repo, "review", "submit", "--verdict", "changes_requested", "--as", "human:nick");

  expect((await lrJson<StatusOk>(repo, "status")).data.uiUrl).toBe(ROUND_1);
  expect((await lr(repo, "status")).out).toContain(`Review UI: ${ROUND_1}\nNext:`);
  expect((await lrJson<Handoff>(repo, "handoff")).data.uiUrl).toBe(ROUND_1);
  expect((await lr(repo, "handoff")).out).toContain(
    `open thread(s)  \n**Review UI:** ${ROUND_1}\n\n`,
  );

  const r = await lrJson<ReviewCreateOk>(repo, "review", "create");
  expect(r.data.uiUrl).toBe("http://127.0.0.1:4321/f/feat/r/2");
});

test("the session-start hook tells the agent where the UI is", async () => {
  await lr(repo, "review", "create");
  await serving();
  const r = await lrWithStdin(repo, JSON.stringify({ cwd: repo.root }), "hook", "session-start");
  expect(r.out).toContain(
    `The developer's review UI (\`lr ui\`) is running; round 1 is at ${ROUND_1}`,
  );
});

test("no links when no UI is running, or its process is gone", async () => {
  const none = await lr(repo, "review", "create");
  expect(none.out).not.toContain("Review it in the browser");

  const exited = Bun.spawn(["true"]);
  await exited.exited;
  await serving(exited.pid);
  const { data } = await lrJson<StatusOk>(repo, "status");
  expect(data.uiUrl).toBeNull();
  expect((await lr(repo, "status")).out).not.toContain("Review UI");
});

test("status has no link before the first round", async () => {
  await serving();
  expect((await lrJson<StatusOk>(repo, "status")).data.uiUrl).toBeNull();
});
