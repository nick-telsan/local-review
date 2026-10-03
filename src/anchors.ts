import { posix } from "node:path";
import { LrError } from "./errors.ts";
import type { Jj } from "./jj.ts";
import type { Anchor, ChangeSnapshot, Phase, RevRef, Round } from "./model.ts";
import type { Snapshot } from "./snapshot.ts";
import type { CommentInput } from "./submission.ts";

type CodeAnchor = Extract<Anchor, { kind: "code" }>;

/**
 * Turns comment locations from a review file into anchors on a round's snapshot, checking them
 * against the repo as it was when the round was taken. Notes resolve against the live stack's
 * snapshot instead.
 */
export class AnchorResolver {
  private readonly jj: Jj;
  private readonly round: Snapshot & { final: Round["final"] };
  /** How errors name what the location was checked against: `round 3`, or `the stack`. */
  private readonly where: string;

  constructor(
    jj: Jj,
    stack: Round | Snapshot,
    private readonly phases: Phase[],
    /** The plan the round was taken against, for comments on it. */
    private readonly plan: { version: number; text: string } | null = null,
  ) {
    this.jj = jj.at(stack.jjOpId);
    const round = "n" in stack ? stack : null;
    this.round = { ...stack, warnings: [], final: round?.final ?? null };
    this.where = round ? `round ${round.n}` : "the stack";
  }

  async resolve(c: CommentInput): Promise<Anchor> {
    if (c.final !== null || c.prBody) return this.finalAnchor(c);
    if (c.plan) return this.planAnchor(c.lines);
    const change = c.change === null ? null : findChange(this.round.changes, c.change, this.where);

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

  /** A comment on a final commit's message or on the PR body, as frozen in a final round. */
  private finalAnchor(c: CommentInput): Anchor {
    const final = this.round.final;
    if (!final) {
      throw new LrError(
        `${this.where} reviews code; final and pr_body comments need a final round`,
      );
    }
    let text: string;
    let what: string;
    if (c.final !== null) {
      const group = final.groups.find((g) => g.id === c.final);
      if (!group) {
        throw new LrError(
          `no final commit "${c.final}" in ${this.where} (groups: ${final.groups.map((g) => g.id).join(", ")})`,
        );
      }
      text = group.message;
      what = `the message of final commit ${group.id}`;
    } else {
      text = final.prBody;
      what = "the PR body";
    }
    const lines = splitLines(text);
    if (c.lines) checkRange(c.lines, lines.length, what);
    const snippet = c.lines ? lines.slice(c.lines[0] - 1, c.lines[1]) : lines;
    return c.final !== null
      ? { kind: "final", groupId: c.final, lines: c.lines, snippet }
      : { kind: "pr_body", lines: c.lines, snippet };
  }

  /** A comment on the plan file, whole or some of its lines. */
  private planAnchor(lines: [number, number] | null): Anchor {
    if (!this.plan) throw new LrError(`${this.where} has no plan to comment on`);
    const text = splitLines(this.plan.text);
    if (lines) checkRange(lines, text.length, `plan v${this.plan.version}`);
    return {
      kind: "plan",
      version: this.plan.version,
      lines,
      snippet: lines ? text.slice(lines[0] - 1, lines[1]) : text,
    };
  }

  private phaseChanges(phaseId: number): ChangeSnapshot[] {
    if (!this.phases.some((p) => p.id === phaseId)) {
      throw new LrError(
        `phase ${phaseId} isn't in the plan (phases: ${this.phases.map((p) => p.id).join(", ")})`,
      );
    }
    const changes = this.round.changes.filter((c) => c.phaseId === phaseId);
    if (changes.length === 0) {
      throw new LrError(`phase ${phaseId} has no changes in ${this.where}`);
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
    return { from: refAt(this.round, i - 1), to: { changeId: change.changeId } };
  }

  /** The combined diff of one phase, or of the whole stack when no phase is given. */
  private phaseView(phaseId: number | null): CodeAnchor["view"] {
    const changes = phaseId === null ? this.round.changes : this.phaseChanges(phaseId);
    const first = this.round.changes.indexOf(changes[0]!);
    return { from: refAt(this.round, first - 1), to: { changeId: changes.at(-1)!.changeId } };
  }

  private async codeAnchor(
    view: CodeAnchor["view"],
    path: string,
    side: "old" | "new",
    lines: [number, number],
    commentedChange: ChangeSnapshot | null,
  ): Promise<CodeAnchor> {
    const rev = refCommit(this.round, side === "new" ? view.to : view.from);
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
    const to = refIndex(this.round, view.to);
    for (let i = to; i > refIndex(this.round, view.from); i--) {
      if (owners.includes(changes[i]!.changeId)) return changes[i]!;
    }
    return changes[to]!;
  }

  /** Views always end at a change, never at the base. */
  private changeOf(ref: RevRef): ChangeSnapshot {
    return this.round.changes[refIndex(this.round, ref)]!;
  }

  private describe(view: CodeAnchor["view"]): string {
    const name = (r: RevRef) => (r === "base" ? "base" : r.changeId.slice(0, 8));
    return `${name(view.from)}..${name(view.to)}`;
  }
}

/** A stack's base and changes, as a round or a note's `anchorStack` records them. */
type Stack = { baseCommitId: string; changes: { changeId: string; commitId: string }[] };

/** A full change id, or a unique prefix of one, among `changes` (`where`: e.g. `round 3`). */
export function findChange(
  changes: ChangeSnapshot[],
  prefix: string,
  where: string,
): ChangeSnapshot {
  const matches = changes.filter((c) => c.changeId.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  const available = changes.map((c) => c.changeId.slice(0, 8)).join(", ");
  if (matches.length === 0) {
    throw new LrError(`change "${prefix}" isn't in ${where} (changes: ${available})`);
  }
  throw new LrError(`change "${prefix}" is ambiguous in ${where}`);
}

/**
 * Like `findChange`, for the live stack: a change can also be named by a revset, such as `@-` or a
 * bookmark, that resolves to one of its changes. `jj` should be pinned to the stack's operation.
 */
export async function findLiveChange(
  jj: Jj,
  changes: ChangeSnapshot[],
  arg: string,
  where: string,
): Promise<ChangeSnapshot> {
  if (changes.some((c) => c.changeId.startsWith(arg))) return findChange(changes, arg, where);
  let found: Awaited<ReturnType<Jj["commits"]>>;
  try {
    found = await jj.commits(arg);
  } catch {
    // Not a revset either: say what is in the stack.
    return findChange(changes, arg, where);
  }
  if (found.length !== 1) {
    throw new LrError(`"${arg}" is ${found.length} commits; name one change`);
  }
  const commit = found[0]!;
  const change = changes.find((c) => c.changeId === commit.changeId);
  if (change) return change;
  const available = changes.map((c) => c.changeId.slice(0, 8)).join(", ");
  const [wc] = await jj.commits("@");
  const what =
    commit.changeId === wc!.changeId
      ? " (the working copy; its parent is @-)"
      : commit.commitId === "0".repeat(40)
        ? " (the root commit)"
        : "";
  throw new LrError(
    `${arg} is ${commit.changeId.slice(0, 8)}${what}, which isn't in ${where} (changes: ${available})`,
  );
}

/** Position of a ref in a round's stack; the base is -1, and a change not in it is -1 too. */
export function refIndex(round: Stack, ref: RevRef): number {
  return ref === "base" ? -1 : round.changes.findIndex((c) => c.changeId === ref.changeId);
}

/** The ref at a position in a round's stack. */
export function refAt(round: Stack, index: number): RevRef {
  return index < 0 ? "base" : { changeId: round.changes[index]!.changeId };
}

/** The commit a ref pointed at in a round. */
export function refCommit(round: Stack, ref: RevRef): string {
  const i = refIndex(round, ref);
  return i < 0 ? round.baseCommitId : round.changes[i]!.commitId;
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
export function splitLines(text: string): string[] {
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
    case "final":
      return `final ${anchor.groupId}${anchor.lines ? `:${range(anchor.lines)}` : ""}`;
    case "pr_body":
      return `PR body${anchor.lines ? `:${range(anchor.lines)}` : ""}`;
    case "plan":
      return `plan v${anchor.version}${anchor.lines ? `:${range(anchor.lines)}` : ""}`;
  }
}
