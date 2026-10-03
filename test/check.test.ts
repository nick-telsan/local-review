import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CheckOk } from "../src/commands/check.ts";
import type { ReviewCreateOk } from "../src/commands/review.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson } from "./lr.ts";

// main: README.md and three checks: `ok` at the tip, `schema` at phase bookmarks, and `flaky`,
// which passes once <tmp>/ready exists.
// c1 (phase 1, feat/1-schema): adds schema.sql; c2 (phase 2, feat/2-rotation): adds rotate.ts
let repo: TestRepo;
let c1: string, c2: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", {
    "README.md": "hello\n",
    ".local-review.toml": [
      '[[checks]]\nname = "ok"\nrun = "true"',
      '[[checks]]\nname = "schema"\nrun = "test -f schema.sql"\nat = "bookmarks"',
      `[[checks]]\nname = "flaky"\nrun = "test -f ${join(repo.tmp, "ready")}"`,
    ].join("\n"),
  });
  await repo.bookmark("main");
  c1 = await repo.commit("Add table", { "schema.sql": "create table t;\n" });
  await repo.bookmark("feat/1-schema");
  c2 = await repo.commit("Rotate", { "rotate.ts": "export {};\n" });
  await repo.bookmark("feat/2-rotation");
  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
});

afterEach(() => repo.cleanup());

const ready = () => Bun.write(join(repo.tmp, "ready"), "");
const runs = (d: CheckOk) =>
  d.checks.map((c) => `${c.check}@${c.changeId.slice(0, 4)}:${c.status}`);
const at = (c: string) => c.slice(0, 4);

async function check(...args: string[]): Promise<{ code: number; data: CheckOk }> {
  const r = await lrJson<CheckOk>(repo, "check", ...args);
  expect(r.err).toBe("");
  return r;
}

describe("lr check", () => {
  test("on the stack before a round; the round reuses the passes", async () => {
    await ready();
    const r = await check();
    expect(r.code).toBe(0);
    expect(r.data.round).toBeNull();
    expect(runs(r.data)).toEqual([
      `schema@${at(c1)}:pass`,
      `ok@${at(c2)}:pass`,
      `schema@${at(c2)}:pass`,
      `flaky@${at(c2)}:pass`,
    ]);
    expect(r.data.checks.map((c) => [c.trigger, c.cached])).toEqual(
      Array(4).fill(["manual", false]),
    );

    const again = await lr(repo, "check");
    expect(again.out).toBe(
      [
        "Checks on the stack: 4/4 passed (4 cached; --rerun runs them again)",
        `  pass   schema @ ${c1.slice(0, 8)}`,
        `  pass   ok @ ${c2.slice(0, 8)}`,
        `  pass   schema @ ${c2.slice(0, 8)}`,
        `  pass   flaky @ ${c2.slice(0, 8)}`,
      ].join("\n"),
    );
    expect((await check("--rerun")).data.checks.map((c) => c.cached)).toEqual(Array(4).fill(false));

    const round = await lrJson<ReviewCreateOk>(repo, "review", "create");
    expect(round.data.checks.map((c) => c.cached)).toEqual(Array(4).fill(true));
  });

  test("named changes get every check; --check picks which", async () => {
    await ready();
    expect(runs((await check(c1.slice(0, 6))).data)).toEqual([
      `ok@${at(c1)}:pass`,
      `schema@${at(c1)}:pass`,
      `flaky@${at(c1)}:pass`,
    ]);
    expect(runs((await check(c1, "@-", c1, "--check", "ok, schema")).data)).toEqual([
      `ok@${at(c1)}:pass`,
      `schema@${at(c1)}:pass`,
      `ok@${at(c2)}:pass`,
      `schema@${at(c2)}:pass`,
    ]);
  });

  test("a failing check exits 1 and points at its log", async () => {
    const r = await lr(repo, "check", "--check", "flaky");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      new RegExp(
        `^Checks on the stack: 0/1 passed\\n  fail   flaky @ ${c2.slice(0, 8)}  log: /.+\\.log$`,
      ),
    );
  });

  test("--round reruns a check on a round's commits, and the round shows the rerun", async () => {
    await lr(repo, "review", "create", "--allow-failing");
    expect((await lr(repo, "status")).out).toContain(`  fail   flaky @ ${c2.slice(0, 8)}`);
    // The author moves on; the round's commits are what gets checked.
    await repo.write("rotate.ts", "export const x = 1;\n");

    await ready();
    const r = await check("--round", "1", "--check", "flaky");
    expect(r.data.round).toBe(1);
    expect(r.data.checks[0]).toMatchObject({ status: "pass", commitId: await roundCommit(c2) });
    const status = (await lr(repo, "status")).out;
    expect(status).toContain(`  pass   flaky @ ${c2.slice(0, 8)}`);
    expect(status).not.toContain("fail");
    expect((await lr(repo, "handoff")).out).not.toContain("Fix the failing checks");
  });

  test("a finished feature's commits can only be checked by round", async () => {
    await ready();
    await lr(repo, "review", "create");
    await lr(repo, "feature", "abandon", "--as", "human:nick");
    expect((await lr(repo, "check", "--feature", "feat")).err).toContain(
      'feature "feat" is abandoned; check a round\'s commits with --round',
    );
    expect((await check("--feature", "feat", "--round", "1")).code).toBe(0);
  });

  test("bad input", async () => {
    const err = async (...args: string[]) => (await lr(repo, "check", ...args)).err;
    expect(await err("--check", "ok,nope")).toContain(
      "no check named nope (checks: ok, schema, flaky)",
    );
    expect(await err("nope(")).toContain(`change "nope(" isn't in the stack`);
    expect(await err("--round", "1")).toContain("no review round yet");
    await repo.jj("bookmark", "forget", "feat/1-schema", "feat/2-rotation");
    await repo.jj("new", c1);
    expect(await err("--check", "schema")).toContain(
      "none of these checks apply to the stack (see each check's `at`)",
    );
    await repo.write(".local-review.toml", "");
    expect(await err()).toContain("no checks configured");
  });
});

async function roundCommit(change: string): Promise<string> {
  const r = await lrJson<{ round: { changes: { changeId: string; commitId: string }[] } }>(
    repo,
    "status",
  );
  return r.data.round.changes.find((c) => c.changeId === change)!.commitId;
}
