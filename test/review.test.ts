import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ReviewCreateBlocked, ReviewCreateOk } from "../src/commands/review.ts";
import type { Feature, PlanVersion, Round } from "../src/model.ts";
import { featureDir } from "../src/paths.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson } from "./lr.ts";

type StatusJson = { feature: Feature; round: Round | null };

let repo: TestRepo;
let c1: string, c2: string, c3: string;

const CONFIG = `
[[checks]]
name = "schema-ok"
run = "grep -q good schema.sql && touch check-was-here"
at = "bookmarks"

[[checks]]
name = "tip"
run = "echo tip-ran; test -f rotate.ts"
`;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n", ".local-review.toml": CONFIG });
  await repo.bookmark("main");
  c1 = await repo.commit("Add table", { "schema.sql": "good\n" });
  c2 = await repo.commit("Backfill", { "backfill.sql": "insert;\n" });
  await repo.bookmark("feat/1-schema");
  c3 = await repo.commit("Rotate on use", { "rotate.ts": "export {};\n" });
  await repo.bookmark("feat/2-rotation");

  expect((await lr(repo, "feature", "start", "feat", "--base", "main")).code).toBe(0);
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  expect((await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"))).code).toBe(0);
});

afterEach(() => repo.cleanup());

describe("lr review create", () => {
  test("opens a round with the stack, checks, and patches", async () => {
    const { code, data } = await lrJson<ReviewCreateOk>(
      repo,
      "review",
      "create",
      "--as",
      "agent:claude-code",
    );
    expect(code).toBe(0);
    expect(data.ok).toBe(true);
    expect(data.round.n).toBe(1);
    expect(data.round.createdBy).toEqual({ kind: "agent", name: "claude-code" });
    expect(data.round.changes.map((c) => [c.changeId, c.phaseId])).toEqual([
      [c1, 1],
      [c2, 1],
      [c3, 2],
    ]);

    // schema-ok at both bookmarks, tip at c3.
    const checks = data.checks.map((c) => [c.check, c.changeId, c.status]);
    expect(checks).toEqual([
      ["schema-ok", c2, "pass"],
      ["schema-ok", c3, "pass"],
      ["tip", c3, "pass"],
    ]);
    const tipLog = await Bun.file(data.checks[2]!.logPath).text();
    expect(tipLog).toContain("tip-ran");

    const patches = readdirSync(join(featureDir(repo.root, "feat"), "rounds", "1", "patches"));
    expect(patches.sort()).toEqual([c1, c2, c3].map((c) => `${c}.patch`).sort());

    // Checks ran in the workspace, not the developer's working copy.
    expect(existsSync(join(repo.root, "check-was-here"))).toBe(false);
    expect(
      existsSync(join(featureDir(repo.root, "feat"), "workspaces", "checks", "check-was-here")),
    ).toBe(false);
    const status = await repo.jj(
      "log",
      "--no-graph",
      "-r",
      "all()",
      "-T",
      'description.first_line() ++ "\\n"',
    );
    expect(status).not.toContain("check-was-here");
  });

  test("a failing check blocks the round; the fix re-runs only what changed", async () => {
    await repo.jj("edit", c1);
    await repo.write("schema.sql", "bad\n");
    await repo.jj("new", "feat/2-rotation");

    const failed = await lrJson<ReviewCreateBlocked>(repo, "review", "create");
    expect(failed.code).toBe(1);
    expect(failed.data.ok).toBe(false);
    const failing = failed.data.checks.filter((c) => c.status !== "pass");
    expect(failing.map((c) => c.check)).toEqual(["schema-ok", "schema-ok"]);
    expect((await lrJson<StatusJson>(repo, "status")).data.round).toBeNull();

    await repo.jj("edit", c1);
    await repo.write("schema.sql", "good\n");
    await repo.jj("new", "feat/2-rotation");

    const ok = await lrJson<ReviewCreateOk>(repo, "review", "create");
    expect(ok.code).toBe(0);
    expect(ok.data.checks.every((c) => c.status === "pass" && !c.cached)).toBe(true);

    // Nothing changed: everything comes from cache and the old round is superseded.
    const again = await lrJson<ReviewCreateOk>(repo, "review", "create");
    expect(again.code).toBe(0);
    expect(again.data.round.n).toBe(2);
    expect(again.data.superseded).toBe(1);
    expect(again.data.checks.every((c) => c.cached)).toBe(true);
  });

  test("--allow-failing opens the round anyway", async () => {
    await repo.jj("edit", c3);
    await Bun.file(join(repo.root, "rotate.ts")).delete();
    await repo.jj("new", "feat/2-rotation");

    const r = await lrJson<ReviewCreateOk>(repo, "review", "create", "--allow-failing");
    expect(r.code).toBe(0);
    expect(r.data.checks.find((c) => c.check === "tip")?.status).toBe("fail");
  });

  test("a check that times out is an error", async () => {
    await repo.write(
      ".local-review.toml",
      `[[checks]]\nname = "slow"\nrun = "sleep 5"\nat = "bookmarks"\ntimeout = "300ms"\n`,
    );
    const r = await lrJson<ReviewCreateBlocked>(repo, "review", "create");
    expect(r.code).toBe(1);
    expect(r.data.checks.map((c) => c.status)).toEqual(["error", "error"]);
    expect(await Bun.file(r.data.checks[0]!.logPath).text()).toContain("killed by SIGKILL");
  });

  test("a failing setup marks that commit's checks as errors", async () => {
    await repo.write(
      ".local-review.toml",
      `setup = "echo setting up; exit 3"\n[[checks]]\nname = "never"\nrun = "true"\nat = "bookmarks"\n`,
    );
    const r = await lrJson<ReviewCreateBlocked>(repo, "review", "create");
    expect(r.code).toBe(1);
    expect(r.data.checks.map((c) => c.status)).toEqual(["error", "error"]);
    expect(await Bun.file(r.data.checks[0]!.logPath).text()).toContain("setting up");
  });

  test("conflicted changes block the round", async () => {
    // Rewrite c1 so that c2 conflicts with it.
    await repo.jj("edit", c2);
    await repo.write("schema.sql", "good\nfrom c2\n");
    await repo.jj("edit", c1);
    await repo.write("schema.sql", "good\nfrom c1\n");
    await repo.jj("new", "feat/2-rotation");

    const r = await lrJson<ReviewCreateBlocked>(repo, "review", "create", "--skip-checks");
    expect(r.code).toBe(1);
    // jj carries the conflict into descendants.
    expect(r.data.conflicted).toEqual([c2, c3]);
  });

  test("status reports the round and checks", async () => {
    await lr(repo, "review", "create");
    const r = await lr(repo, "status");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Status: in_review");
    expect(r.out).toContain("Round 1 (open, plan v1)");
    expect(r.out).toContain("Phase 2: Rotation [feat/2-rotation]");
  });
});

describe("lr plan", () => {
  test("revise records the round it responds to and moves to revising", async () => {
    await lr(repo, "review", "create");
    const r = await lrJson<{ plan: PlanVersion }>(
      repo,
      "plan",
      "revise",
      "-F",
      join(repo.tmp, "plan.md"),
    );
    expect(r.code).toBe(0);
    expect(r.data.plan).toMatchObject({ version: 2, respondsToRound: 1, path: "plan/v2.md" });
    expect((await lrJson<StatusJson>(repo, "status")).data.feature.status).toBe("revising");
  });

  test("submit refuses a second plan", async () => {
    const r = await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("use `lr plan revise`");
  });
});
