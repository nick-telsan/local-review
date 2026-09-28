import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DiffOk } from "../src/commands/diff.ts";
import { Store } from "../src/store.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson } from "./lr.ts";

// main: README.md
// c1 (phase 1, feat/1-schema): adds db.ts
// c2 (phase 2): adds rotate.ts
// c3 (phase 2, feat/2-rotation): adds keep.ts
let repo: TestRepo;
let c1: string, c2: string, c3: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Add db", { "db.ts": "a\nb\nc\n" });
  await repo.bookmark("feat/1-schema");
  c2 = await repo.commit("Rotate", { "rotate.ts": "r1\n" });
  c3 = await repo.commit("Keep", { "keep.ts": "k1\n" });
  await repo.bookmark("feat/2-rotation");
  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
  expect((await lr(repo, "review", "create")).code).toBe(0);
});

afterEach(() => repo.cleanup());

/** Round 2: c1's code and message edited, c3 squashed into c2, and a new change on top. */
async function revise(): Promise<string> {
  await repo.write("db.ts", "a\nB\nc\n");
  await repo.jj("squash", "--into", c1, "db.ts");
  await repo.jj("describe", c1, "-m", "Add the db");
  await repo.jj("squash", "--from", c3, "--into", c2, "-u");
  await repo.jj("new", c2, "-m", "Extra\n\nWhy extra.");
  await repo.write("extra.ts", "e\n");
  await repo.bookmark("feat/2-rotation", "@");
  const extra = (await repo.jj("log", "--no-graph", "-r", "@", "-T", "change_id")).trim();
  await repo.jj("new");
  await nextRound();
  return extra;
}

async function nextRound(): Promise<void> {
  const r = await lr(repo, "review", "create");
  expect(r.err).not.toContain("error");
  expect(r.code).toBe(0);
}

async function diff(...args: string[]): Promise<DiffOk> {
  const r = await lrJson<DiffOk>(repo, "diff", ...args);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.data;
}

describe("lr diff", () => {
  test("change by change: edited, added, and squashed away", async () => {
    const extra = await revise();
    const d = await diff();
    expect(d).toMatchObject({ from: 1, to: 2, lastReviewed: false, baseMoved: null });
    expect(d.changes.map((c) => [c.changeId, c.status])).toEqual([
      [c1, "changed"],
      [c2, "changed"],
      [extra, "added"],
      [c3, "removed"],
    ]);
    const [db, rotate, added, gone] = d.changes;
    expect(db).toMatchObject({ messageChanged: true, files: ["db.ts"], phaseId: 1 });
    expect(db!.patch).toContain("-Add db\n+Add the db");
    expect(db!.patch).toContain("-b\n+B");
    expect(rotate).toMatchObject({ messageChanged: false, files: ["keep.ts"] });
    expect(added).toMatchObject({ fromCommitId: null, files: ["extra.ts"] });
    expect(added!.patch).toContain("+++ b/extra.ts");
    expect(gone).toMatchObject({ toCommitId: null, squashedInto: c2, patch: "" });

    const text = (await lr(repo, "diff")).out;
    expect(text).toStartWith("Round 1 → round 2: 2 changed, 1 added, 1 removed\n\nPhase 1: Schema");
    expect(text).toContain(
      `  ${c1.slice(0, 8)}  Add the db  (changed; message edited)\n\ndiff --git`,
    );
    expect(text).toContain(
      `  ${extra.slice(0, 8)}  Extra  (added)\n    | Extra\n    | \n    | Why extra.`,
    );
    expect(text).toEndWith(
      `Removed:\n  ${c3.slice(0, 8)}  Keep  (removed; squashed into ${c2.slice(0, 8)})`,
    );

    expect((await lr(repo, "diff", "--name-only")).out).toBe(
      [
        "Round 1 → round 2: 2 changed, 1 added, 1 removed",
        "",
        "Phase 1: Schema [feat/1-schema]",
        `  ${c1.slice(0, 8)}  Add the db  (changed; message edited)`,
        "      db.ts",
        "",
        "Phase 2: Rotation [feat/2-rotation]",
        `  ${c2.slice(0, 8)}  Rotate  (changed)`,
        "      keep.ts",
        `  ${extra.slice(0, 8)}  Extra  (added)`,
        "      extra.ts",
        "",
        "Removed:",
        `  ${c3.slice(0, 8)}  Keep  (removed; squashed into ${c2.slice(0, 8)})`,
      ].join("\n"),
    );
  });

  test("a rebase alone changes nothing", async () => {
    await repo.jj("new", "main", "-m", "trunk");
    await repo.write("README.md", "hello, trunk\n");
    await repo.bookmark("main", "@");
    await repo.jj("rebase", "-s", c1, "-d", "main");
    await repo.jj("new", c3);
    await nextRound();
    const d = await diff();
    expect(d.baseMoved).not.toBeNull();
    expect(d.changes.map((c) => [c.status, c.patch])).toEqual([
      ["unchanged", ""],
      ["unchanged", ""],
      ["unchanged", ""],
    ]);
    const text = (await lr(repo, "diff")).out;
    expect(text).toContain("Round 1 → round 2: 3 unchanged\nRebased (base ");
    expect(text).toContain("what landed on the base isn't shown.");
  });

  test("an abandoned change, and one that moved phases", async () => {
    await repo.bookmark("feat/1-schema", c2);
    await repo.jj("abandon", c1);
    await nextRound();
    const d = await diff();
    expect(d.changes.find((c) => c.changeId === c2)).toMatchObject({
      status: "changed",
      phaseId: 1,
      movedFromPhase: 2,
      patch: "",
    });
    expect(d.changes.find((c) => c.changeId === c1)).toMatchObject({
      status: "removed",
      squashedInto: null,
    });
    expect((await lr(repo, "diff")).out).toContain("Rotate  (changed; moved from phase 2)");
  });

  test("the default is since your last review", async () => {
    await lr(repo, "review", "submit", "-m", "Looks fine", "--as", "agent:codex");
    await repo.jj("describe", c1, "-m", "Add the db");
    await nextRound();
    await repo.jj("describe", c2, "-m", "Rotate keys");
    await nextRound();

    expect(await diff("--as", "agent:codex")).toMatchObject({ from: 1, to: 3, lastReviewed: true });
    expect((await lr(repo, "diff", "--as", "agent:codex")).out).toStartWith(
      "Round 1 (your last review) → round 3: 2 changed, 1 unchanged",
    );
    expect(await diff("--as", "agent:other")).toMatchObject({ from: 2, lastReviewed: false });
    expect(await diff("--from", "1", "--to", "2", "--as", "agent:codex")).toMatchObject({
      from: 1,
      to: 2,
      lastReviewed: false,
    });
  });

  test("one change, including one that's gone", async () => {
    await revise();
    expect((await diff(c1.slice(0, 6))).changes.map((c) => c.changeId)).toEqual([c1]);
    expect((await diff(c3)).changes.map((c) => c.status)).toEqual(["removed"]);
    expect((await lr(repo, "diff", "zzzz")).err).toContain(`change "zzzz" isn't in round 1 or 2`);
  });

  test("an earlier commit that's gone shows the whole change", async () => {
    await repo.jj("describe", c1, "-m", "Add the db");
    await nextRound();
    const store = await Store.open(repo.root);
    store.db
      .query("UPDATE round_changes SET commit_id = ? WHERE round = 1 AND change_id = ?")
      .run("f".repeat(40), c1);
    store.close();
    const [db] = (await diff()).changes;
    expect(db).toMatchObject({
      status: "changed",
      files: ["db.ts"],
      note: "the earlier commit is gone, so this is the whole change",
    });
  });

  test("needs two rounds, in order", async () => {
    expect((await lr(repo, "diff")).err).toContain(
      "round 1 is the first; there's no earlier round to compare",
    );
    await repo.jj("describe", c1, "-m", "Add the db");
    await nextRound();
    expect((await lr(repo, "diff", "--from", "2", "--to", "1")).err).toContain(
      "--from must be an earlier round than 1",
    );
    expect((await lr(repo, "diff", "--from", "9")).err).toContain("no round 9 (latest is 2)");
  });
});
