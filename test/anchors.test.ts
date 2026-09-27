import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AnchorResolver, describeAnchor } from "../src/anchors.ts";
import { Jj } from "../src/jj.ts";
import type { Anchor, ChangeSnapshot, Round } from "../src/model.ts";
import { parsePlan } from "../src/plan.ts";
import { takeSnapshot } from "../src/snapshot.ts";
import type { CommentInput } from "../src/submission.ts";
import { TestRepo } from "./helpers.ts";

const { phases } = parsePlan(
  `---
phases:
  - { id: 1, title: Schema, bookmark: feat/1-schema }
  - { id: 2, title: Rotation, bookmark: feat/2-rotation }
  - { id: 3, title: Later, bookmark: feat/3-later }
---
`,
  "feat",
);

const comment = (fields: Partial<CommentInput>): CommentInput => ({
  change: null,
  phase: null,
  path: null,
  lines: null,
  side: "new",
  message: false,
  severity: null,
  body: "x",
  suggestion: null,
  ...fields,
});

// main: app.ts = a b c
// c1 (phase 1): app.ts line 2 b → B; adds db.ts
// c2 (phase 1, feat/1-schema): app.ts adds line 4 "d"
// c3 (phase 2, feat/2-rotation): adds rotate.ts
let repo: TestRepo;
let round: Round;
let resolver: AnchorResolver;
let c1: string, c2: string, c3: string;

beforeAll(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "src/app.ts": "a\nb\nc\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Capitalize b", { "src/app.ts": "a\nB\nc\n", "db.ts": "db\n" });
  c2 = await repo.commit("Add d", { "src/app.ts": "a\nB\nc\nd\n" });
  await repo.bookmark("feat/1-schema");
  c3 = await repo.commit("Rotate on use\n\nWhy we rotate.\nMore detail.", { "rotate.ts": "r\n" });
  await repo.bookmark("feat/2-rotation");

  const jj = new Jj(repo.root);
  const snap = await takeSnapshot(jj, "main", phases.slice(0, 2));
  round = {
    n: 1,
    jjOpId: snap.jjOpId,
    planVersion: 1,
    baseCommitId: snap.baseCommitId,
    changes: snap.changes,
    status: "open",
    verdict: null,
    createdBy: { kind: "agent", name: "test" },
    createdAt: "",
  };
  resolver = new AnchorResolver(jj, round, phases);

  // Rewrite history afterwards: resolution must still read the round's snapshot.
  await repo.jj("edit", c1);
  await repo.write("src/app.ts", "changed\nafter\nthe\nround\n");
  await repo.jj("new", "feat/2-rotation");
});

afterAll(() => repo.cleanup());

const resolve = (fields: Partial<CommentInput>) => resolver.resolve(comment(fields));
const code = async (fields: Partial<CommentInput>) =>
  (await resolve(fields)) as Extract<Anchor, { kind: "code" }>;

describe("AnchorResolver", () => {
  test("general, phase, and change anchors", async () => {
    expect(await resolve({})).toEqual({ kind: "feature" });
    expect(await resolve({ phase: 2 })).toEqual({ kind: "phase", phaseId: 2 });
    expect(await resolve({ change: c1.slice(0, 4) })).toEqual({ kind: "change", changeId: c1 });
  });

  test("unknown phases and phases without changes", async () => {
    await expect(resolve({ phase: 9 })).rejects.toThrow(/phase 9 isn't in the plan/);
    await expect(resolve({ phase: 3 })).rejects.toThrow(/phase 3 has no changes in round 1/);
  });

  test("unknown and ambiguous change ids", async () => {
    await expect(resolve({ change: "zzzzzzzz" })).rejects.toThrow(/isn't in round 1/);
    const twins: ChangeSnapshot[] = [
      { ...round.changes[0]!, changeId: "kkkkaaaa" },
      { ...round.changes[1]!, changeId: "kkkkbbbb" },
    ];
    const fake = new AnchorResolver(new Jj(repo.root), { ...round, changes: twins }, phases);
    await expect(fake.resolve(comment({ change: "kkkk" }))).rejects.toThrow(/ambiguous/);
  });

  test("commit message anchors", async () => {
    expect(await resolve({ change: c3, message: true, lines: [3, 4] })).toEqual({
      kind: "message",
      changeId: c3,
      commitId: round.changes[2]!.commitId,
      lines: [3, 4],
      snippet: ["Why we rotate.", "More detail."],
    });
    const whole = await resolve({ change: c1, message: true });
    expect(whole).toMatchObject({ lines: null, snippet: ["Capitalize b"] });
    await expect(resolve({ change: c1, message: true, lines: [2, 2] })).rejects.toThrow(
      /past the end of the message/,
    );
  });

  test("code in a single change's diff belongs to that change", async () => {
    const a = await code({ change: c1, path: "src/app.ts", lines: [2, 2] });
    expect(a).toMatchObject({
      view: { from: "base", to: { changeId: c1 } },
      changeId: c1,
      commitId: round.changes[0]!.commitId,
      snippet: ["B"],
    });
    const next = await code({ change: c2, path: "src/app.ts", lines: [4, 4] });
    expect(next.view).toEqual({ from: { changeId: c1 }, to: { changeId: c2 } });
  });

  test("code in the combined diff is attributed to the latest change touching it", async () => {
    const all = { path: "src/app.ts" };
    const span = await code({ ...all, lines: [2, 4] });
    expect(span).toMatchObject({
      view: { from: "base", to: { changeId: c3 } },
      changeId: c2,
      snippet: ["B", "c", "d"],
    });
    expect((await code({ ...all, lines: [2, 2] })).changeId).toBe(c1);
    // Untouched context falls back to the end of the view.
    expect((await code({ ...all, lines: [3, 3] })).changeId).toBe(c3);
  });

  test("a phase's combined diff", async () => {
    const a = await code({ phase: 1, path: "src/app.ts", lines: [2, 2] });
    expect(a).toMatchObject({ view: { from: "base", to: { changeId: c2 } }, changeId: c1 });
    const later = await code({ phase: 2, path: "rotate.ts", lines: [1, 1] });
    expect(later.view).toEqual({ from: { changeId: c2 }, to: { changeId: c3 } });
  });

  test("old-side lines read the view's starting point", async () => {
    const a = await code({ change: c1, path: "src/app.ts", lines: [2, 2], side: "old" });
    expect(a).toMatchObject({ side: "old", snippet: ["b"], changeId: c1 });
    const combined = await code({ path: "src/app.ts", lines: [2, 2], side: "old" });
    expect(combined).toMatchObject({ snippet: ["b"], changeId: c3 });
    await expect(
      resolve({ change: c1, path: "db.ts", lines: [1, 1], side: "old" }),
    ).rejects.toThrow(/db.ts doesn't exist on the old side of base..[a-z]{8}/);
  });

  test("paths are normalized and must stay in the repo", async () => {
    expect((await code({ path: "./src//app.ts", lines: [1, 1] })).path).toBe("src/app.ts");
    await expect(resolve({ path: "../etc/passwd", lines: [1, 1] })).rejects.toThrow(
      /relative to the repo root/,
    );
    await expect(resolve({ path: "/etc/passwd", lines: [1, 1] })).rejects.toThrow(
      /relative to the repo root/,
    );
  });

  test("missing files, directories, and lines past the end", async () => {
    await expect(resolve({ path: "nope.ts", lines: [1, 1] })).rejects.toThrow(/doesn't exist/);
    await expect(resolve({ path: "src", lines: [1, 1] })).rejects.toThrow(/doesn't exist/);
    await expect(resolve({ path: "src/app.ts", lines: [4, 5] })).rejects.toThrow(
      /lines 4-5 are past the end of src\/app.ts \(new side\) \(4 lines\)/,
    );
  });
});

test("describeAnchor", async () => {
  expect(describeAnchor({ kind: "feature" })).toBe("general");
  expect(describeAnchor({ kind: "phase", phaseId: 2 })).toBe("phase 2");
  expect(describeAnchor({ kind: "change", changeId: "kxqpmwyzabc" })).toBe("change kxqpmwyz");
  const message = { kind: "message" as const, changeId: "kxqpmwyzabc", commitId: "", snippet: [] };
  expect(describeAnchor({ ...message, lines: null })).toBe("message of kxqpmwyz");
  expect(describeAnchor({ ...message, lines: [1, 3] })).toBe("message of kxqpmwyz:1-3");
  const c = await code({ path: "src/app.ts", lines: [2, 2] });
  expect(describeAnchor(c)).toBe(`src/app.ts:2 @${c1.slice(0, 8)}`);
  expect(describeAnchor({ ...c, lines: [2, 4], side: "old" })).toBe(
    `src/app.ts:2-4 (old) @${c1.slice(0, 8)}`,
  );
});
