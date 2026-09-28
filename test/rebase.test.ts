import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { FinalApplyOk } from "../src/commands/final.ts";
import type { RebaseOk } from "../src/commands/rebase.ts";
import type { ReviewCreateBlocked, ReviewCreateOk } from "../src/commands/review.ts";
import type { ThreadsOk } from "../src/commands/thread.ts";
import { Jj } from "../src/jj.ts";
import type { Feature, Round } from "../src/model.ts";
import { codeChanges, takeSnapshot } from "../src/snapshot.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson, lrWithStdin } from "./lr.ts";

const NICK = ["--as", "human:nick"];
const CONFIG = `
[[checks]]
name = "not-broken"
run = "test ! -f broken"
`;
const LIB = "one\ntwo\nthree\nfour\nfive\n";

// main: README.md, lib.ts, .local-review.toml
// phase 1 (feat/1-schema): c1 adds schema.sql
// phase 2 (feat/2-rotation): c2 edits line 4 of lib.ts
let repo: TestRepo;
let c1: string, c2: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", {
    "README.md": "hello\n",
    "lib.ts": LIB,
    ".local-review.toml": CONFIG,
  });
  await repo.bookmark("main");
  c1 = await repo.commit("Add table", { "schema.sql": "create table t;\n" });
  await repo.bookmark("feat/1-schema");
  c2 = await repo.commit("Rotate", { "lib.ts": LIB.replace("four", "FOUR") });
  await repo.bookmark("feat/2-rotation");

  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
});

afterEach(() => repo.cleanup());

/**
 * Land a commit on main (or start `bookmark` off main with it), leaving the working copy on top of
 * the stack.
 */
async function land(files: Record<string, string>, bookmark = "main"): Promise<string> {
  await repo.jj("new", "main");
  for (const [path, content] of Object.entries(files)) await repo.write(path, content);
  await repo.jj("describe", "-m", `Land ${Object.keys(files).join(", ")}`);
  await repo.bookmark(bookmark, "@");
  await repo.jj("new", "feat/2-rotation");
  return repo.commitId(bookmark);
}

async function rebase(...args: string[]): Promise<RebaseOk> {
  const r = await lrJson<RebaseOk>(repo, "rebase", ...args);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.data;
}

const stackOn = async (rev: string) =>
  (await repo.jj("log", "--no-graph", "-r", `${rev}..feat/2-rotation`, "-T", 'change_id ++ "\\n"'))
    .trim()
    .split("\n");

describe("lr rebase", () => {
  test("rebases the stack onto its base, bookmarks and working copy included", async () => {
    const oldMain = await repo.commitId("main");
    const newMain = await land({ "trunk.txt": "new\n" });

    const r = await rebase();
    expect(r).toMatchObject({
      rebased: true,
      onto: { revset: "main", commitId: newMain },
      fromBase: oldMain,
      conflicted: [],
      next: "carry on; the next `lr review create` runs the checks on the rebased stack",
    });
    expect(r.changes.map((c) => [c.changeId, c.phaseId])).toEqual([
      [c1, 1],
      [c2, 2],
    ]);
    expect(await stackOn("main")).toEqual([c2, c1]);
    expect(await repo.commitId("@-")).toBe(await repo.commitId("feat/2-rotation"));

    const text = await lr(repo, "rebase");
    expect(text.out).toContain(
      `feat is already on main (${newMain.slice(0, 8)}); nothing to rebase.`,
    );
    expect(text.out).toContain("Next: nothing");

    // The undo point puts the stack back.
    await repo.jj("op", "restore", r.opBefore);
    expect(await repo.commitId(`${c1}-`)).toBe(oldMain);
  });

  test("prints the stack and the undo point", async () => {
    await land({ "trunk.txt": "new\n" });
    const r = await lr(repo, "rebase");
    expect(r.out).toMatch(/^Rebased feat onto main \([0-9a-f]{8}, was [0-9a-f]{8}\): 2 changes/);
    expect(r.out).toContain("Phase 2: Rotation [feat/2-rotation]");
    expect(r.out).toMatch(/Undo with `jj op restore [0-9a-f]{12}`\./);
  });

  test("reports the changes it left conflicted", async () => {
    await land({ "lib.ts": LIB.replace("four", "4") });
    const r = await rebase();
    expect(r.conflicted).toEqual([c2]);
    expect(r.next).toStartWith("resolve each conflict in the change where it appears");

    const text = await lr(repo, "rebase");
    expect(text.out).toContain(`Conflicted: 1 change (${c2.slice(0, 8)})`);
  });

  test("--onto moves the stack to a new base, which sticks", async () => {
    const other = await land({ "other.txt": "x\n" }, "other");
    const r = await rebase("--onto", "other");
    expect(r.onto).toEqual({ revset: "other", commitId: other });
    const status = await lrJson<{ feature: Feature }>(repo, "status");
    expect(status.data.feature.baseRevset).toBe("other");

    const round = await lrJson<ReviewCreateOk>(repo, "review", "create");
    expect(round.data.round.baseCommitId).toBe(other);
    expect(round.data.round.changes.map((c) => c.changeId)).toEqual([c1, c2]);
    expect((await lr(repo, "rebase", "--onto", "main")).out).toContain(
      "The feature's base is now main.",
    );
  });

  test("refuses a target in the stack or one that isn't a single commit", async () => {
    expect((await lr(repo, "rebase", "--onto", "feat/1-schema")).err).toContain(
      "feat/1-schema is in the stack itself",
    );
    expect((await lr(repo, "rebase", "--onto", "none()")).err).toContain(
      "expected revset none() to resolve to one commit, got 0",
    );
  });
});

describe("rounds across a rebase", () => {
  beforeEach(async () => {
    await lr(repo, "review", "create");
  });

  test("an open round keeps its snapshot; the next one carries threads across", async () => {
    const review = { comments: [{ change: c2, path: "lib.ts", lines: 4, body: "Why caps?" }] };
    await lrWithStdin(repo, JSON.stringify(review), "review", "submit", "-F", "-");
    await land({ "lib.ts": `zero\n${LIB}` });

    const r = await rebase();
    expect(r.next).toStartWith("round 1 still shows the stack as it was");
    const round1 = (await lrJson<{ round: Round }>(repo, "status")).data.round!;
    expect(round1.baseCommitId).not.toBe(r.onto.commitId);

    const round2 = await lrJson<ReviewCreateOk>(repo, "review", "create");
    expect(round2.data.reanchored).toMatchObject([{ id: 1, anchorState: "moved" }]);
    const t = (await lrJson<ThreadsOk>(repo, "threads")).data.threads[0]!;
    expect(t.anchor).toMatchObject({ path: "lib.ts", lines: [5, 5], snippet: ["FOUR"] });
  });
});

describe("finalizing across a rebase", () => {
  const draftAll = async () => {
    await lrWithStdin(repo, "Add the table", "final", "message", "1", "-F", "-");
    await lrWithStdin(repo, "Rotate", "final", "message", "2", "-F", "-");
    await lrWithStdin(repo, "## Summary", "final", "pr-body", "-F", "-");
  };

  beforeEach(async () => {
    await lr(repo, "review", "create");
    await lr(repo, "review", "submit", "--verdict", "approved", ...NICK);
    await draftAll();
  });

  test("a clean rebase keeps the approval, and the checks run on the new commits", async () => {
    const newMain = await land({ "trunk.txt": "new\n" });
    expect((await rebase()).next).toStartWith("a clean rebase keeps the approval");

    const final = await lrJson<ReviewCreateOk>(repo, "review", "create", "--final");
    expect(final.code).toBe(0);
    expect(final.data.round.baseCommitId).toBe(newMain);
    expect(final.data.checks.map((c) => [c.check, c.cached, c.status])).toEqual([
      ["not-broken", false, "pass"],
    ]);
    expect(final.data.warnings).toContain(
      "the stack was rebased since round 1 was approved; the code is the same, and the checks " +
        "ran on the new commits",
    );

    await lr(repo, "review", "submit", "--verdict", "approved", ...NICK);
    const applied = await lrJson<FinalApplyOk>(repo, "final", "apply");
    expect(applied.err).toBe("");
    expect(applied.data.rebased).toBe(false);
    expect(await stackOn("main")).toEqual([c2, c1]);
  });

  test("a rebase after the final approval is checked before applying", async () => {
    await lr(repo, "review", "create", "--final");
    await lr(repo, "review", "submit", "--verdict", "approved", ...NICK);
    await land({ "trunk.txt": "new\n" });
    expect((await rebase()).next).toStartWith(
      "a clean rebase keeps the approval; `lr final apply` runs the checks",
    );

    const applied = await lr(repo, "final", "apply");
    expect(applied.code).toBe(0);
    expect(applied.err).toContain("not-broken: pass");
    expect(applied.out).toContain(
      "(rebased after the approval: same code, and the checks pass on it)",
    );
    expect((await repo.jj("log", "--no-graph", "-r", `${c2}-`, "-T", "description")).trim()).toBe(
      "Add the table",
    );
  });

  test("checks that fail on the rebased stack block finalizing", async () => {
    await land({ broken: "yes\n" });
    await rebase();
    const final = await lrJson<ReviewCreateBlocked>(repo, "review", "create", "--final");
    expect(final.code).toBe(1);
    expect(final.data).toMatchObject({ ok: false, checks: [{ status: "fail" }] });
    expect((await lr(repo, "review", "create", "--final")).out).toContain(
      "No final round opened: checks fail on the rebased stack.",
    );
  });

  test("checks that fail after the final approval block the apply", async () => {
    await lr(repo, "review", "create", "--final");
    await lr(repo, "review", "submit", "--verdict", "approved", ...NICK);
    await land({ broken: "yes\n" });
    await rebase();
    const r = await lr(repo, "final", "apply");
    expect(r.code).toBe(1);
    expect(r.err).toContain("checks fail on the rebased stack, so nothing was applied:");
    expect(r.err).toContain(`fail: not-broken @ ${c2.slice(0, 8)}`);
  });

  test("a conflict sends the code back for review", async () => {
    await land({ "lib.ts": LIB.replace("four", "4") });
    expect((await rebase()).next).toEndWith(
      "Resolving them changes code a human approved, so it needs a code round.",
    );
    expect((await lr(repo, "review", "create", "--final")).err).toContain(
      `the code changed since round 1 was approved (${c2.slice(0, 8)} is conflicted)`,
    );

    await repo.write("lib.ts", LIB.replace("four", "4").replace("five", "FIVE"));
    await repo.jj("squash", "--into", c2);
    expect((await lr(repo, "review", "create", "--final")).err).toContain(
      `(${c2.slice(0, 8)}'s diff changed in lib.ts)`,
    );
  });
});

describe("codeChanges", () => {
  test("names what differs beyond the commit ids", async () => {
    const jj = new Jj(repo.root);
    const phases = [
      { id: 1, title: "Schema", bookmark: "feat/1-schema", doneWhen: null, tasks: [] },
      { id: 2, title: "Rotation", bookmark: "feat/2-rotation", doneWhen: null, tasks: [] },
    ];
    const { changes } = await takeSnapshot(jj, "main", phases);
    const [a, b] = changes as [(typeof changes)[0], (typeof changes)[0]];
    const short = (id: string) => id.slice(0, 8);

    expect(await codeChanges(jj, changes, changes)).toEqual([]);
    expect(await codeChanges(jj, changes, [a])).toEqual([`${short(c2)} removed`]);
    expect(await codeChanges(jj, [a], changes)).toEqual([`${short(c2)} added`]);
    expect(await codeChanges(jj, changes, [b, a])).toEqual(["the changes were reordered"]);
    expect(await codeChanges(jj, changes, [a, { ...b, phaseId: 1 }])).toEqual([
      `${short(c2)} moved from phase 2 to 1`,
    ]);

    await repo.jj("describe", c1, "-m", "Add the table");
    const described = (await takeSnapshot(jj, "main", phases)).changes;
    expect(await codeChanges(jj, changes, described)).toEqual([`${short(c1)}'s message changed`]);
  });
});
