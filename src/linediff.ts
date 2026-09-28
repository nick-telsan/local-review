// A line diff of two texts, in hunks like a patch's. For short texts (plan versions); it's
// quadratic in their line counts. Shared by the server and the web UI, so it uses nothing Bun-specific.
import type { DiffHunk, DiffLine } from "./patch.ts";

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** How `b` differs from `a`, with `context` unchanged lines around each change. */
export function diffLines(a: string, b: string, context = 3): DiffHunk[] {
  const x = lines(a);
  const y = lines(b);
  // lcs[i][j]: the longest common subsequence of x[i..] and y[j..].
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  const line = (kind: DiffLine["kind"], text: string): DiffLine => ({
    kind,
    oldLine: kind === "add" ? null : i + 1,
    newLine: kind === "del" ? null : j + 1,
    text,
    noNewline: false,
  });
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      all.push(line("context", x[i]!));
      i++;
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // Deletions first, as in a patch.
      all.push(line("del", x[i]!));
      i++;
    } else {
      all.push(line("add", y[j]!));
      j++;
    }
  }

  // Keep the changed lines and their context; each run of kept lines is a hunk.
  const keep = all.map(() => false);
  all.forEach((l, k) => {
    if (l.kind === "context") return;
    for (let c = Math.max(0, k - context); c <= Math.min(all.length - 1, k + context); c++) {
      keep[c] = true;
    }
  });
  const hunks: DiffHunk[] = [];
  let hunk: DiffLine[] | null = null;
  all.forEach((l, k) => {
    if (!keep[k]) {
      hunk = null;
      return;
    }
    if (!hunk) {
      hunk = [];
      hunks.push({ oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, lines: hunk });
    }
    hunk.push(l);
  });
  for (const h of hunks) {
    const olds = h.lines.filter((l) => l.oldLine !== null);
    const news = h.lines.filter((l) => l.newLine !== null);
    h.oldStart = olds[0]?.oldLine ?? 0;
    h.oldCount = olds.length;
    h.newStart = news[0]?.newLine ?? 0;
    h.newCount = news.length;
  }
  return hunks;
}
