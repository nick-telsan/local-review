import { expect, test } from "bun:test";
import { diffLines } from "../src/linediff.ts";

const show = (a: string, b: string, context?: number) =>
  diffLines(a, b, context).map((h) => ({
    at: [h.oldStart, h.oldCount, h.newStart, h.newCount],
    lines: h.lines.map((l) => `${{ context: " ", add: "+", del: "-" }[l.kind]}${l.text}`),
  }));

test("changed lines, with context, in hunks", () => {
  const a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
  const b = "1\ntwo\n3\n4\n5\n6\n7\n8\n9\n10\n11\n";
  expect(show(a, b, 1)).toEqual([
    { at: [1, 3, 1, 3], lines: [" 1", "-2", "+two", " 3"] },
    { at: [10, 1, 10, 2], lines: [" 10", "+11"] },
  ]);
  // Close changes share a hunk.
  expect(show(a, b, 5)).toHaveLength(1);
});

test("the same text, an empty one, and line numbers on each side", () => {
  expect(diffLines("a\nb\n", "a\nb")).toEqual([]);
  expect(show("", "a\nb\n")).toEqual([{ at: [0, 0, 1, 2], lines: ["+a", "+b"] }]);
  expect(show("a\nb\n", "")).toEqual([{ at: [1, 2, 0, 0], lines: ["-a", "-b"] }]);
  const [hunk] = diffLines("a\nb\nc\n", "a\nc\nd\n");
  expect(hunk!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
    ["context", 1, 1],
    ["del", 2, null],
    ["context", 3, 2],
    ["add", null, 3],
  ]);
});
