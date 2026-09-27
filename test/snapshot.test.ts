import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Jj } from "../src/jj.ts";
import { parsePlan } from "../src/plan.ts";
import { takeSnapshot } from "../src/snapshot.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";

const { phases } = parsePlan(TWO_PHASE_PLAN, "feat");

let repo: TestRepo;
let c1: string, c2: string, c3: string;

// main ─ c1 ─ c2 (feat/1-schema) ─ c3 (feat/2-rotation) ─ @ (empty)
beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Add table\n\nPlan-Task: 1.1", { "schema.sql": "create table t;\n" });
  c2 = await repo.commit("Backfill\n\nPlan-Task: 1.2", { "backfill.sql": "insert;\n" });
  await repo.bookmark("feat/1-schema");
  c3 = await repo.commit("Rotate on use", { "rotate.ts": "export {};\n" });
  await repo.bookmark("feat/2-rotation");
});

afterEach(() => repo.cleanup());

const snap = () => takeSnapshot(new Jj(repo.root), "main", phases);

describe("takeSnapshot", () => {
  test("assigns changes to phases, base → tip, ignoring an empty @", async () => {
    const s = await snap();
    expect(s.changes.map((c) => [c.changeId, c.phaseId])).toEqual([
      [c1, 1],
      [c2, 1],
      [c3, 2],
    ]);
    expect(s.baseCommitId).toBe(await repo.commitId("main"));
    expect(s.warnings).toEqual([]);
    expect(s.changes[0]!.trailers).toEqual([["Plan-Task", "1.1"]]);
    expect(s.changes[0]!.stats).toEqual({ files: 1, added: 1, removed: 0 });
    expect(s.changes[1]!.bookmarks).toEqual(["feat/1-schema"]);
  });

  test("includes described changes above the last bookmark, unassigned", async () => {
    const extra = await repo.commit("WIP extra", { "x.ts": "x\n" });
    const s = await snap();
    expect(s.changes.at(-1)).toMatchObject({ changeId: extra, phaseId: null });
    expect(s.warnings.join("\n")).toContain("aren't in any phase");
  });

  test("treats work past the last bookmark as unassigned (phase in progress)", async () => {
    await repo.jj("bookmark", "delete", "feat/2-rotation");
    const s = await snap();
    expect(s.changes.map((c) => [c.changeId, c.phaseId])).toEqual([
      [c1, 1],
      [c2, 1],
      [c3, null],
    ]);
    expect(s.warnings.join("\n")).toContain("phases not started");
    expect(s.warnings.join("\n")).toContain("aren't in any phase");
  });

  test("stops at the last bookmark when @ is elsewhere", async () => {
    await repo.jj("bookmark", "delete", "feat/2-rotation");
    await repo.jj("new", "main");
    const s = await snap();
    expect(s.changes.map((c) => c.changeId)).toEqual([c1, c2]);
  });

  test("errors when no phase bookmark exists", async () => {
    await repo.jj("bookmark", "delete", "feat/1-schema", "feat/2-rotation");
    await expect(snap()).rejects.toThrow(/no phase bookmarks exist/);
  });

  test("uses the fork point when the base has moved ahead", async () => {
    const forkPoint = await repo.commitId("main");
    await repo.jj("new", "main");
    await repo.commit("trunk moved", { "other.txt": "o\n" });
    await repo.bookmark("main");
    const s = await snap();
    expect(s.baseCommitId).toBe(forkPoint);
    expect(s.changes).toHaveLength(3);
  });

  test("ignores @ when it's not on top of the stack", async () => {
    await repo.jj("new", "main");
    await repo.write("elsewhere.txt", "e\n");
    const s = await snap();
    expect(s.changes.map((c) => c.changeId)).toEqual([c1, c2, c3]);
  });

  test("rejects a non-linear stack", async () => {
    await repo.jj("new", "main", "-m", "side");
    await repo.write("side.txt", "s\n");
    await repo.jj("rebase", "-r", c3, "-d", c2, "-d", "@");
    await expect(snap()).rejects.toThrow(/must be linear/);
  });

  test("rejects phase bookmarks out of plan order", async () => {
    await repo.bookmark("feat/1-schema", c3);
    await repo.bookmark("feat/2-rotation", c2);
    await expect(snap()).rejects.toThrow(/out of plan order/);
  });

  test("rejects two phase bookmarks on one change", async () => {
    await repo.bookmark("feat/1-schema", c3);
    await expect(snap()).rejects.toThrow(/multiple phase bookmarks/);
  });

  test("rejects a phase bookmark outside the stack", async () => {
    await repo.jj("new", "main", "-m", "unrelated");
    await repo.write("u.txt", "u\n");
    await repo.bookmark("feat/1-schema", "@");
    await repo.jj("new", "feat/2-rotation");
    await expect(snap()).rejects.toThrow(/feat\/1-schema \(phase 1\) points outside the stack/);
  });

  test("rejects an empty stack", async () => {
    await repo.jj("new", "main");
    await repo.bookmark("feat/1-schema", "main");
    await repo.jj("bookmark", "delete", "feat/2-rotation");
    await expect(snap()).rejects.toThrow(/stack is empty/);
  });

  test("warns about changes without a description", async () => {
    await repo.jj("describe", "-r", c2, "-m", "");
    const s = await snap();
    expect(s.warnings.join("\n")).toContain("without a description");
  });

  test("pins reads to one operation", async () => {
    const s = await snap();
    const ops = await repo.jj("op", "log", "--no-graph", "-T", 'id ++ "\\n"');
    expect(ops.split("\n")).toContain(s.jjOpId);
  });
});
