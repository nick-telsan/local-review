// Parses `jj diff --git` output into files, hunks, and lines. Shared by the server and the web UI,
// so it uses nothing Bun-specific.

export interface DiffLine {
  kind: "context" | "add" | "del";
  /** 1-based line in the old file, for context and deleted lines. */
  oldLine: number | null;
  /** 1-based line in the new file, for context and added lines. */
  newLine: number | null;
  text: string;
  /** Followed by `\ No newline at end of file`. */
  noNewline: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  status: "added" | "deleted" | "modified" | "renamed";
  /** null for an added file. */
  oldPath: string | null;
  /** null for a deleted file. */
  newPath: string | null;
  binary: boolean;
  /** Set when the file mode changed, e.g. made executable. */
  mode: { from: string; to: string } | null;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * jj never quotes paths, so a path can hold spaces. Paths come from the `---`/`+++` and `rename`
 * lines; the `diff --git a/P b/P` header is only split when those are missing (an empty file, a
 * binary, a mode change), and then both halves are the same path.
 */
export function parsePatch(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      const path = rest.slice(2, 2 + (rest.length - 5) / 2);
      file = {
        status: "modified",
        oldPath: path,
        newPath: path,
        binary: false,
        mode: null,
        hunks: [],
        added: 0,
        removed: 0,
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (hunk) {
      const kind = line[0];
      if (kind === " " || kind === "+" || kind === "-") {
        const text = line.slice(1);
        if (kind === " ") {
          hunk.lines.push({
            kind: "context",
            oldLine: oldLine++,
            newLine: newLine++,
            text,
            noNewline: false,
          });
        } else if (kind === "+") {
          hunk.lines.push({
            kind: "add",
            oldLine: null,
            newLine: newLine++,
            text,
            noNewline: false,
          });
          file.added++;
        } else {
          hunk.lines.push({
            kind: "del",
            oldLine: oldLine++,
            newLine: null,
            text,
            noNewline: false,
          });
          file.removed++;
        }
        continue;
      }
      if (line.startsWith("\\")) {
        const last = hunk.lines.at(-1);
        if (last) last.noNewline = true;
        continue;
      }
    }

    const m = HUNK.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldCount: Number(m[2] ?? 1),
        newStart: Number(m[3]),
        newCount: Number(m[4] ?? 1),
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      file.hunks.push(hunk);
    } else if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.oldPath = null;
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.newPath = null;
    } else if (line.startsWith("old mode ")) {
      file.mode = { from: line.slice("old mode ".length), to: "" };
    } else if (line.startsWith("new mode ") && file.mode) {
      file.mode.to = line.slice("new mode ".length);
    } else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      file.newPath = line.slice("rename to ".length);
    } else if (line.startsWith("--- a/")) {
      file.oldPath = line.slice("--- a/".length);
    } else if (line.startsWith("+++ b/")) {
      file.newPath = line.slice("+++ b/".length);
    } else if (line.startsWith("Binary files ")) {
      file.binary = true;
    }
  }
  return files;
}

/** The path a file is shown under: its new path, or its old one if it was deleted. */
export function filePath(f: FileDiff): string {
  return (f.newPath ?? f.oldPath)!;
}
