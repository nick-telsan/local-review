import { posix } from "node:path";
import { LrError } from "./errors.ts";
import type { Jj } from "./jj.ts";
import type { Anchor, ChangeSnapshot, Phase, RevRef, Round } from "./model.ts";
import type { CommentInput } from "./submission.ts";

type CodeAnchor = Extract<Anchor, { kind: "code" }>;

/**
 * Turns comment locations from a review file into anchors on a round's snapshot, checking them
 * against the repo as it was when the round was taken.
 */
export class AnchorResolver {
  private readonly jj: Jj;

  constructor(
    jj: Jj,
    private readonly round: Round,
    private readonly phases: Phase[],
  ) {
    this.jj = jj.at(round.jjOpId);
  }

  async resolve(c: CommentInput): Promise<Anchor> {
    const change = c.change === null ? null : this.findChange(c.change);

    if (c.message) {
      return this.messageAnchor(change!, c.lines);
    }
    if (c.path !== null) {
      const view = change ? this.changeView(change) : this.phaseView(c.phase);
      return this.codeAnchor(view, normalizePath(c.path), c.side, c.lines!, change);
    }
    if (change) return { kind: "change", changeId: change.changeId };
    if (c.phase !== null) {
      this.phaseChanges(c.phase); // validates the phase
      return { kind: "phase", phaseId: c.phase };
    }
    return { kind: "feature" };
  }

  /** A full change id or a unique prefix of one in this round. */
  private findChange(prefix: string): ChangeSnapshot {
    const matches = this.round.changes.filter((c) => c.changeId.startsWith(prefix));
    if (matches.length === 1) return matches[0]!;
    const available = this.round.changes.map((c) => c.changeId.slice(0, 8)).join(", ");
    if (matches.length === 0) {
      throw new LrError(
        `change "${prefix}" isn't in round ${this.round.n} (changes: ${available})`,
      );
    }
    throw new LrError(`change "${prefix}" is ambiguous in round ${this.round.n}`);
  }

  private phaseChanges(phaseId: number): ChangeSnapshot[] {
    if (!this.phases.some((p) => p.id === phaseId)) {
      throw new LrError(
        `phase ${phaseId} isn't in the plan (phases: ${this.phases.map((p) => p.id).join(", ")})`,
      );
    }
    const changes = this.round.changes.filter((c) => c.phaseId === phaseId);
    if (changes.length === 0) {
      throw new LrError(`phase ${phaseId} has no changes in round ${this.round.n}`);
    }
    return changes;
  }

  private messageAnchor(change: ChangeSnapshot, lines: [number, number] | null): Anchor {
    const text = splitLines(change.description);
    if (lines) checkRange(lines, text.length, `the message of ${short(change)}`);
    return {
      kind: "message",
      changeId: change.changeId,
      commitId: change.commitId,
      lines,
      snippet: lines ? text.slice(lines[0] - 1, lines[1]) : text,
    };
  }

  /** The diff a single change introduces. */
  private changeView(change: ChangeSnapshot): CodeAnchor["view"] {
    const i = this.round.changes.indexOf(change);
    return { from: this.refAt(i - 1), to: { changeId: change.changeId } };
  }

  /** The combined diff of one phase, or of the whole stack when no phase is given. */
  private phaseView(phaseId: number | null): CodeAnchor["view"] {
    const changes = phaseId === null ? this.round.changes : this.phaseChanges(phaseId);
    const first = this.round.changes.indexOf(changes[0]!);
    return { from: this.refAt(first - 1), to: { changeId: changes.at(-1)!.changeId } };
  }

  private refAt(index: number): RevRef {
    return index < 0 ? "base" : { changeId: this.round.changes[index]!.changeId };
  }

  /** Position of a ref in the stack; the base is -1. */
  private indexOf(ref: RevRef): number {
    return ref === "base" ? -1 : this.round.changes.findIndex((c) => c.changeId === ref.changeId);
  }

  private commitOf(ref: RevRef): string {
    const i = this.indexOf(ref);
    return i < 0 ? this.round.baseCommitId : this.round.changes[i]!.commitId;
  }

  private async codeAnchor(
    view: CodeAnchor["view"],
    path: string,
    side: "old" | "new",
    lines: [number, number],
    commentedChange: ChangeSnapshot | null,
  ): Promise<CodeAnchor> {
    const rev = this.commitOf(side === "new" ? view.to : view.from);
    if (!(await this.jj.isFile(rev, path))) {
      throw new LrError(`${path} doesn't exist on the ${side} side of ${this.describe(view)}`);
    }
    const text = splitLines(await this.jj.fileContent(rev, path));
    checkRange(lines, text.length, `${path} (${side} side)`);

    const change =
      commentedChange ??
      (side === "new" ? await this.attribute(view, rev, path, lines) : this.changeOf(view.to));
    return {
      kind: "code",
      view,
      changeId: change.changeId,
      commitId: change.commitId,
      path,
      side,
      lines,
      snippet: text.slice(lines[0] - 1, lines[1]),
    };
  }

  /**
   * In a multi-change view, the fix belongs to the latest change in the view that touched any of
   * the commented lines. Lines no change in the view touched fall back to the view's last change.
   */
  private async attribute(
    view: CodeAnchor["view"],
    rev: string,
    path: string,
    lines: [number, number],
  ): Promise<ChangeSnapshot> {
    const owners = (await this.jj.annotate(rev, path)).slice(lines[0] - 1, lines[1]);
    const changes = this.round.changes;
    const to = this.indexOf(view.to);
    for (let i = to; i > this.indexOf(view.from); i--) {
      if (owners.includes(changes[i]!.changeId)) return changes[i]!;
    }
    return changes[to]!;
  }

  /** Views always end at a change, never at the base. */
  private changeOf(ref: RevRef): ChangeSnapshot {
    return this.round.changes[this.indexOf(ref)]!;
  }

  private describe(view: CodeAnchor["view"]): string {
    const name = (r: RevRef) => (r === "base" ? "base" : r.changeId.slice(0, 8));
    return `${name(view.from)}..${name(view.to)}`;
  }
}

/** Repo-relative, forward slashes, no `..`. */
function normalizePath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new LrError(`path "${path}" must be relative to the repo root`);
  }
  return normalized;
}

/** Split into lines, without a phantom empty line after a trailing newline. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function checkRange(lines: [number, number], count: number, what: string): void {
  if (lines[1] > count) {
    throw new LrError(`lines ${lines[0]}-${lines[1]} are past the end of ${what} (${count} lines)`);
  }
}

function short(c: ChangeSnapshot): string {
  return c.changeId.slice(0, 8);
}

/** `40` or `40-42`. */
export function formatLines(l: [number, number]): string {
  return l[0] === l[1] ? `${l[0]}` : `${l[0]}-${l[1]}`;
}

/** A short human-readable location, e.g. `src/db.ts:40-41 @kxqpmwyz`. */
export function describeAnchor(anchor: Anchor): string {
  const range = formatLines;
  switch (anchor.kind) {
    case "feature":
      return "general";
    case "phase":
      return `phase ${anchor.phaseId}`;
    case "change":
      return `change ${anchor.changeId.slice(0, 8)}`;
    case "message":
      return `message of ${anchor.changeId.slice(0, 8)}${anchor.lines ? `:${range(anchor.lines)}` : ""}`;
    case "code":
      return `${anchor.path}:${range(anchor.lines)}${anchor.side === "old" ? " (old)" : ""} @${anchor.changeId.slice(0, 8)}`;
  }
}
