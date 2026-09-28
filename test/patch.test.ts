import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type FileDiff, filePath, parsePatch } from "../src/patch.ts";
import { TestRepo } from "./helpers.ts";

let repo: TestRepo;
let files: Map<string, FileDiff>;

beforeAll(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", {
    "keep.txt": "a\nb\nc\n",
    "old.txt": "x\ny\nw\nv\n",
    "del.txt": "gone\n",
    "mode.sh": "m\n",
    "bin.dat": "A\0B",
  });
  await repo.write("keep.txt", "a\nB\nc");
  renameSync(join(repo.root, "old.txt"), join(repo.root, "renamed.txt"));
  appendFileSync(join(repo.root, "renamed.txt"), "z\n");
  rmSync(join(repo.root, "del.txt"));
  chmodSync(join(repo.root, "mode.sh"), 0o755);
  await repo.write("empty.txt", "");
  await repo.write('sp ace "q".txt', "hi\n");
  await repo.write("bin.dat", "A\0C");
  const patch = await repo.jj("diff", "--git", "-r", "@");
  files = new Map(parsePatch(patch).map((f) => [filePath(f), f]));
});

afterAll(() => repo.cleanup());

describe("parsePatch", () => {
  test("numbers lines on both sides, and marks a missing final newline", () => {
    const f = files.get("keep.txt")!;
    expect(f).toMatchObject({ status: "modified", oldPath: "keep.txt", added: 2, removed: 2 });
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 });
    expect(f.hunks[0]!.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "a", noNewline: false },
      { kind: "del", oldLine: 2, newLine: null, text: "b", noNewline: false },
      { kind: "del", oldLine: 3, newLine: null, text: "c", noNewline: false },
      { kind: "add", oldLine: null, newLine: 2, text: "B", noNewline: false },
      { kind: "add", oldLine: null, newLine: 3, text: "c", noNewline: true },
    ]);
  });

  test("renames keep both paths and start their hunks mid-file", () => {
    const f = files.get("renamed.txt")!;
    expect(f).toMatchObject({ status: "renamed", oldPath: "old.txt", newPath: "renamed.txt" });
    expect(f.hunks[0]!.oldStart).toBe(2);
    expect(f.hunks[0]!.lines.at(-1)).toMatchObject({ kind: "add", newLine: 5, text: "z" });
  });

  test("added, deleted, and empty files", () => {
    expect(files.get("del.txt")).toMatchObject({ status: "deleted", newPath: null, removed: 1 });
    expect(files.get("empty.txt")).toMatchObject({ status: "added", oldPath: null, hunks: [] });
    expect(files.get('sp ace "q".txt')).toMatchObject({ status: "added", added: 1 });
  });

  test("binaries and mode changes have no hunks", () => {
    expect(files.get("bin.dat")).toMatchObject({ binary: true, hunks: [] });
    expect(files.get("mode.sh")).toMatchObject({
      status: "modified",
      mode: { from: "100644", to: "100755" },
      hunks: [],
    });
  });

  test("an empty patch has no files", () => {
    expect(parsePatch("")).toEqual([]);
  });
});
