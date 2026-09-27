import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ReviewCreateOk } from "../src/commands/review.ts";
import type { ThreadsOk } from "../src/commands/thread.ts";
import { Jj } from "../src/jj.ts";
import type { Anchor, Thread } from "../src/model.ts";
import { parsePlan } from "../src/plan.ts";
import { findLines, mapRange, Reanchorer } from "../src/reanchor.ts";
import { Store } from "../src/store.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson } from "./lr.ts";

const ROTATE = "function rotate() {\n  return 1;\n}\n\nfunction keep() {\n  return 2;\n}\n";
const NICK = ["--as", "human:nick"];

// main: README.md
// c1 (phase 1, feat/1-schema): adds db.ts
// c2 (phase 2): adds rotate.ts, message has a body
// c3 (phase 2, feat/2-rotation): adds keep.ts
let repo: TestRepo;
let c1: string, c2: string, c3: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Add db", { "db.ts": "a\nb\nc\n" });
  await repo.bookmark("feat/1-schema");
  c2 = await repo.commit("Rotate on use\n\nWhy we rotate.", { "rotate.ts": ROTATE });
  c3 = await repo.commit("Keep", { "keep.ts": "k1\nk2\n" });
  await repo.bookmark("feat/2-rotation");

  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
  await lr(repo, "review", "create");
  const review = join(repo.tmp, "review.json");
  await Bun.write(
    review,
    JSON.stringify({
      comments: [
        { change: c2, path: "rotate.ts", lines: 6, body: "code" }, // #1
        { change: c2, message: true, lines: 3, body: "message line" }, // #2
        { change: c1, message: true, body: "whole message" }, // #3
        { change: c3, body: "change" }, // #4
        { change: c3, path: "keep.ts", lines: 2, body: "keep" }, // #5
        { phase: 2, body: "phase" }, // #6
        { body: "general" }, // #7
        { path: "README.md", lines: 1, side: "old", body: "old side" }, // #8
      ],
    }),
  );
  expect((await lr(repo, "review", "submit", "-F", review, "--as", "agent:codex")).code).toBe(0);
});

afterEach(() => repo.cleanup());

/** Move edits into an existing change, the way an author amends in place. */
async function amend(change: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) await repo.write(path, content);
  await repo.jj("squash", "--into", change);
}

async function nextRound(): Promise<ReviewCreateOk> {
  const r = await lrJson<ReviewCreateOk>(repo, "review", "create");
  expect(r.code).toBe(0);
  return r.data;
}

async function thread(id: number): Promise<Thread> {
  const all = (await lrJson<ThreadsOk>(repo, "threads", "--all")).data.threads;
  return all.find((t) => t.id === id)!;
}

const states = (r: ReviewCreateOk) =>
  Object.fromEntries(r.reanchored.map((t) => [t.id, t.anchorState]));
const code = (t: Thread) => t.anchor as Extract<Anchor, { kind: "code" }>;

describe("re-anchoring at lr review create", () => {
  test("a stack rebased onto a new trunk keeps every thread current", async () => {
    await repo.jj("new", "main", "-m", "trunk");
    await repo.write("other.txt", "x\n");
    await repo.jj("bookmark", "set", "main", "-r", "@");
    await repo.jj("rebase", "-s", c1, "-d", "main");
    await repo.jj("new", c3);

    const r = await lr(repo, "review", "create");
    expect(r.out).toContain("Threads: 8 current");
    const t1 = await thread(1);
    expect(t1).toMatchObject({ anchorRound: 2, anchorState: "current" });
    expect(code(t1).lines).toEqual([6, 6]);
    expect(t1.originalAnchor).toMatchObject({ lines: [6, 6] });
    expect(code(t1).commitId).toBe(await repo.commitId(c2));
    expect(code(t1).commitId).not.toBe(code({ ...t1, anchor: t1.originalAnchor }).commitId);
  });

  test("shifted lines move; edited lines go outdated", async () => {
    await amend(c2, { "rotate.ts": `// rotation\n\n${ROTATE}` });
    await repo.jj("describe", c2, "-m", "Rotate on use\n\nContext.\nWhy we rotate.");
    await repo.jj("describe", c1, "-m", "Add the db");
    const r2 = await nextRound();
    expect(states(r2)).toEqual({
      1: "moved",
      2: "moved",
      3: "outdated",
      4: "current",
      5: "current",
      6: "current",
      7: "current",
      8: "current",
    });
    const t1 = await thread(1);
    expect(code(t1)).toMatchObject({ lines: [8, 8], snippet: ["  return 2;"] });
    expect(t1.originalAnchor).toMatchObject({ lines: [6, 6] });
    expect((await thread(2)).anchor).toMatchObject({ lines: [4, 4] });
    // An outdated thread keeps the anchor it had, in the round it had it.
    expect(await thread(3)).toMatchObject({ anchorRound: 1, anchor: { snippet: ["Add db"] } });

    await amend(c2, { "rotate.ts": `// rotation\n\n${ROTATE.replace("return 2", "return 3")}` });
    const r3 = await lr(repo, "review", "create");
    expect(r3.out).toContain("Threads: 5 current, 1 moved (#2), 2 outdated (#1, #3)");
    expect(await thread(1)).toMatchObject({
      anchorRound: 2,
      anchorState: "outdated",
      anchor: { lines: [8, 8] },
    });

    const listed = await lr(repo, "threads");
    expect(listed.out).toContain(`rotate.ts:8 @${c2.slice(0, 8)} (outdated)  code`);
    const handoff = await lr(repo, "handoff", "--round", "1");
    expect(handoff.out).toContain(
      "#### #1 · `rotate.ts:8` (new) · outdated\n\n_This changed after round 2. As it was then:_\n\n```ts\n8 |   return 2;\n```",
    );
    expect(handoff.out).toContain(
      "#### #3 · commit message · outdated\n\n_This changed after round 1. As it was then:_\n\n```\nAdd db\n```",
    );
  });

  test("code that moved within its file is found by its snippet", async () => {
    const swapped = "function keep() {\n  return 2;\n}\n\nfunction rotate() {\n  return 1;\n}\n";
    await amend(c2, { "rotate.ts": swapped });
    expect(states(await nextRound())[1]).toBe("moved");
    expect(code(await thread(1)).lines).toEqual([2, 2]);
  });

  test("a squashed change carries its threads into the change it joined", async () => {
    await repo.jj("squash", "--from", c3, "--into", c2, "-u");
    await repo.bookmark("feat/2-rotation", c2);
    const r = await nextRound();
    expect([states(r)[4], states(r)[5]]).toEqual(["moved", "moved"]);
    expect((await thread(4)).anchor).toEqual({ kind: "change", changeId: c2 });
    expect(code(await thread(5))).toMatchObject({
      view: { from: { changeId: c1 }, to: { changeId: c2 } },
      changeId: c2,
      lines: [2, 2],
    });
  });

  test("an abandoned change outdates its threads", async () => {
    await repo.jj("abandon", c3);
    await repo.bookmark("feat/2-rotation", c2);
    const r = await nextRound();
    expect([states(r)[4], states(r)[5]]).toEqual(["outdated", "outdated"]);
  });

  test("a phase dropped from the plan outdates its threads", async () => {
    const onePhase = TWO_PHASE_PLAN.replace(/ {2}- id: 2[\s\S]*?(?=---)/, "");
    await Bun.write(join(repo.tmp, "plan2.md"), onePhase);
    expect((await lr(repo, "plan", "revise", "-F", join(repo.tmp, "plan2.md"))).code).toBe(0);
    expect(states(await nextRound())[6]).toBe("outdated");
  });

  test("resolved threads stay put until they're reopened", async () => {
    await lr(repo, "reply", "1", "--resolve", ...NICK);
    await amend(c2, { "rotate.ts": `// rotation\n\n${ROTATE}` });
    expect(states(await nextRound())[1]).toBeUndefined();
    expect(await thread(1)).toMatchObject({ anchorRound: 1, anchor: { lines: [6, 6] } });

    await lr(repo, "reply", "1", "--reopen", ...NICK);
    expect(states(await nextRound())[1]).toBe("moved");
    expect(await thread(1)).toMatchObject({ anchorRound: 3, anchor: { lines: [8, 8] } });
  });
});

describe("Reanchorer", () => {
  test("falls back to the snippet when the old commit can't be read", async () => {
    const store = await Store.open(repo.root);
    const round = store.getRound("feat", 1)!;
    const t1 = store.getThread("feat", 1)!;
    store.close();
    const gone = {
      ...round,
      changes: round.changes.map((c) =>
        c.changeId === c2 ? { ...c, commitId: "f".repeat(40) } : c,
      ),
    };
    const { phases } = parsePlan(TWO_PHASE_PLAN, "feat");
    const placement = await new Reanchorer(new Jj(repo.root), round, phases).place(t1, gone);
    expect(placement).toMatchObject({ anchorState: "current", anchor: { lines: [6, 6] } });
  });
});

describe("mapRange", () => {
  const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number) => ({
    oldStart,
    oldCount,
    newStart,
    newCount,
  });

  test("shifts by hunks before the range and ignores hunks after it", () => {
    expect(mapRange([], [3, 4])).toEqual([3, 4]);
    expect(mapRange([hunk(1, 0, 2, 2), hunk(9, 1, 11, 0)], [3, 4])).toEqual([5, 6]);
    expect(mapRange([hunk(1, 2, 0, 0)], [3, 4])).toEqual([1, 2]);
    // Insertions right before the first line, or right after the last, don't touch the range.
    expect(mapRange([hunk(2, 0, 3, 1)], [3, 4])).toEqual([4, 5]);
    expect(mapRange([hunk(4, 0, 5, 3)], [3, 4])).toEqual([3, 4]);
  });

  test("any hunk inside the range touches it", () => {
    expect(mapRange([hunk(4, 1, 4, 1)], [3, 4])).toBeNull();
    expect(mapRange([hunk(2, 2, 2, 0)], [3, 4])).toBeNull();
    expect(mapRange([hunk(3, 0, 4, 1)], [3, 4])).toBeNull();
  });
});

test("findLines only accepts a unique match", () => {
  expect(findLines(["a", "b", "c", "b"], ["b", "c"])).toEqual([2, 3]);
  expect(findLines(["a", "b", "c", "b"], ["b"])).toBeNull();
  expect(findLines(["a"], ["z"])).toBeNull();
  expect(findLines(["a"], [])).toBeNull();
});
