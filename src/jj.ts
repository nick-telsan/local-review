import { LrError } from "./errors.ts";

export interface JjCommit {
  changeId: string;
  commitId: string;
  parents: string[];
  description: string;
  trailers: [string, string][];
  bookmarks: string[];
  conflict: boolean;
  empty: boolean;
  stats: { files: number; added: number; removed: number };
}

// One JSON object per line. `trailers` isn't serializable directly, so it's stringified as
// tab-separated key/value lines and split on our side.
const COMMIT_TEMPLATE = [
  `"{\\"commit\\":" ++ json(self)`,
  `",\\"bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name()))`,
  `",\\"trailers\\":" ++ json(stringify(trailers.map(|t| t.key() ++ "\\t" ++ t.value()).join("\\n")))`,
  `",\\"conflict\\":" ++ json(conflict)`,
  `",\\"empty\\":" ++ json(empty)`,
  `",\\"added\\":" ++ self.diff().stat().total_added()`,
  `",\\"removed\\":" ++ self.diff().stat().total_removed()`,
  `",\\"files\\":" ++ self.diff().stat().files().len()`,
  `"}\\n"`,
].join(" ++ ");

interface RawCommit {
  commit: { commit_id: string; change_id: string; parents: string[]; description: string };
  bookmarks: string[];
  trailers: string;
  conflict: boolean;
  empty: boolean;
  added: number;
  removed: number;
  files: number;
}

/**
 * One hunk of a line diff. A count of 0 means a pure insertion (old side) or deletion (new side),
 * positioned after line `start`.
 */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** Quote a name (e.g. a bookmark) as a jj revset string literal. */
export function revsetString(name: string): string {
  return JSON.stringify(name);
}

/**
 * Thin wrapper over the jj CLI. All reads go through templates, so user config
 * (custom log templates, diff formats) can't change what we parse.
 */
export class Jj {
  constructor(
    /** Workspace root this instance operates on. */
    readonly root: string,
    /** When set, every command reads the repo as of this operation. */
    readonly atOp: string | null = null,
  ) {}

  static async discover(cwd: string): Promise<Jj> {
    const proc = Bun.spawn(["jj", "--no-pager", "--color=never", "root"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new LrError(`not in a jj repo (${cwd}): ${err.trim()}`);
    return new Jj(out.trim());
  }

  at(opId: string): Jj {
    return new Jj(this.root, opId);
  }

  async run(args: string[]): Promise<string> {
    const cmd = ["jj", "--no-pager", "--color=never", "-R", this.root];
    if (this.atOp) cmd.push("--at-op", this.atOp);
    cmd.push(...args);
    // Run from the root so plain path arguments (e.g. to `file annotate`) are root-relative.
    const proc = Bun.spawn(cmd, { cwd: this.root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new LrError(`jj ${args.join(" ")} failed (exit ${code}):\n${err.trim()}`);
    }
    return out;
  }

  /** Snapshot the working copy, then return the resulting operation id. */
  async snapshotOp(): Promise<string> {
    if (this.atOp) return this.atOp;
    await this.run(["util", "snapshot"]);
    const id = await this.run([
      "op",
      "log",
      "-n1",
      "--no-graph",
      "--ignore-working-copy",
      "-T",
      "id",
    ]);
    return id.trim();
  }

  /** Commits in `revset`, in jj's default order (children before parents). */
  async commits(revset: string): Promise<JjCommit[]> {
    const out = await this.run(["log", "--no-graph", "-r", revset, "-T", COMMIT_TEMPLATE]);
    return out
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const raw = JSON.parse(line) as RawCommit;
        return {
          changeId: raw.commit.change_id,
          commitId: raw.commit.commit_id,
          parents: raw.commit.parents,
          description: raw.commit.description,
          trailers: parseTrailers(raw.trailers),
          bookmarks: raw.bookmarks,
          conflict: raw.conflict,
          empty: raw.empty,
          stats: { files: raw.files, added: raw.added, removed: raw.removed },
        };
      });
  }

  async single(revset: string): Promise<JjCommit> {
    const found = await this.commits(revset);
    if (found.length !== 1) {
      throw new LrError(`expected revset ${revset} to resolve to one commit, got ${found.length}`);
    }
    return found[0]!;
  }

  async diffGit(rev: string): Promise<string> {
    return this.run(["diff", "--git", "-r", rev]);
  }

  /** The `--git` diff between two revisions; empty when their trees are the same. */
  async diffBetween(from: string, to: string): Promise<string> {
    return this.run(["diff", "--git", "--from", from, "--to", to]);
  }

  /**
   * The files whose patch differs between `from` and `to`: `from` is rebased onto `to`'s parent
   * before comparing, so what a rebase brought in doesn't count. Messages don't count either. A
   * change that conflicts the same way in both comes out empty.
   */
  async interdiffFiles(from: string, to: string): Promise<string[]> {
    const out = await this.run(["interdiff", "--name-only", "--from", from, "--to", to]);
    return out.split("\n").filter((l) => l.length > 0);
  }

  /** Rebase `source` and all its descendants onto `onto`. */
  async rebase(source: string, onto: string): Promise<void> {
    await this.run(["rebase", "--source", source, "--onto", onto]);
  }

  /** Squash `from` (change ids) into `into`, giving the result `message`. */
  async squash(from: string[], into: string, message: string): Promise<void> {
    await this.run(["squash", "--from", from.join("|"), "--into", into, "-m", message]);
  }

  async describe(rev: string, message: string): Promise<void> {
    await this.run(["describe", rev, "-m", message]);
  }

  /**
   * Forget local bookmarks. Unlike deleting, this never propagates to a remote: remote bookmarks
   * they tracked become untracked.
   */
  async forgetBookmarks(names: string[]): Promise<void> {
    if (names.length) await this.run(["bookmark", "forget", ...names.map((n) => `exact:${n}`)]);
  }

  /** Which of `ids` (commit ids) this repo has. */
  async presentCommits(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const revset = ids.map((id) => `present(${id})`).join(" | ");
    const out = await this.run(["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\n"']);
    return out.split("\n").filter((l) => l.length > 0);
  }

  async workspaceNames(): Promise<string[]> {
    const out = await this.run(["workspace", "list", "-T", 'name ++ "\n"']);
    return out.split("\n").filter((l) => l.length > 0);
  }

  /** Stop tracking a workspace; jj abandons its working-copy commit if it's empty. */
  async forgetWorkspace(name: string): Promise<void> {
    await this.run(["workspace", "forget", name]);
  }

  /** Put the repo back as it was at operation `op`. */
  async restoreOp(op: string): Promise<void> {
    await this.run(["op", "restore", op]);
  }

  /** Whether `path` (root-relative) is a file at `rev`. Directories don't count. */
  async isFile(rev: string, path: string): Promise<boolean> {
    const out = await this.run(["file", "list", "-r", rev, rootFile(path)]);
    return out.trim() === path;
  }

  async fileContent(rev: string, path: string): Promise<string> {
    return this.run(["file", "show", "-r", rev, rootFile(path)]);
  }

  /**
   * Every commit in `rev`'s evolution, newest first, including the history of changes that were
   * squashed into it.
   */
  async evolog(rev: string): Promise<string[]> {
    const out = await this.run([
      "evolog",
      "--no-graph",
      "-r",
      rev,
      "-T",
      'commit.commit_id() ++ "\\n"',
    ]);
    return out.split("\n").filter((l) => l.length > 0);
  }

  /**
   * The line hunks that turn `path` at `from` into `path` at `to`, with no context lines. Parsed
   * from `--git` output, which user config can't reshape.
   */
  /**
   * The hunks of `path` between two revisions, following it to `newPath` if it was renamed. Both
   * paths must be one file's before and after, or jj would show two diffs.
   */
  async hunks(from: string, to: string, path: string, newPath = path): Promise<Hunk[]> {
    const paths = newPath === path ? [path] : [path, newPath];
    const out = await this.run([
      "diff",
      "--git",
      "--context=0",
      "--from",
      from,
      "--to",
      to,
      ...paths.map(rootFile),
    ]);
    return [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
      oldStart: Number(m[1]),
      oldCount: Number(m[2] ?? 1),
      newStart: Number(m[3]),
      newCount: Number(m[4] ?? 1),
    }));
  }

  /** Files renamed between two revisions (as jj detects them, edits included): old → new path. */
  async renames(from: string, to: string): Promise<Map<string, string>> {
    const out = await this.run([
      "diff",
      "--from",
      from,
      "--to",
      to,
      "-T",
      'if(status == "renamed", "[" ++ json(source.path()) ++ "," ++ json(target.path()) ++ "]\n")',
    ]);
    const renames = new Map<string, string>();
    for (const line of out.split("\n").filter((l) => l.length > 0)) {
      const [source, target] = JSON.parse(line) as [string, string];
      renames.set(source, target);
    }
    return renames;
  }

  /** The change id that last touched each line of `path` at `rev` (index 0 = line 1). */
  async annotate(rev: string, path: string): Promise<string[]> {
    const out = await this.run([
      "file",
      "annotate",
      "-r",
      rev,
      "-T",
      'commit.change_id() ++ "\\n"',
      path,
    ]);
    return out.split("\n").filter((l) => l.length > 0);
  }
}

/** A fileset matching exactly one root-relative file. */
function rootFile(path: string): string {
  return `root-file:${revsetString(path)}`;
}

function parseTrailers(text: string): [string, string][] {
  if (!text) return [];
  return text.split("\n").map((line) => {
    const tab = line.indexOf("\t");
    return [line.slice(0, tab), line.slice(tab + 1)];
  });
}
