import { refAt, refCommit, splitLines } from "./anchors.ts";
import { LrError } from "./errors.ts";
import type { Hunk, Jj } from "./jj.ts";
import type {
  Anchor,
  AnchorStack,
  AnchorState,
  ChangeSnapshot,
  Phase,
  Round,
  Thread,
} from "./model.ts";
import type { Store } from "./store.ts";

type CodeAnchor = Extract<Anchor, { kind: "code" }>;
type MessageAnchor = Extract<Anchor, { kind: "message" }>;

/** Where a thread landed in a new round. Outdated threads keep their last good anchor and round. */
export interface Placement {
  anchor: Anchor;
  /** null: an outdated note that no round has placed yet. */
  anchorRound: number | null;
  anchorState: AnchorState;
}

/**
 * What an anchor was made against: a round's snapshot, or (`n` null) the stack a note was
 * written on.
 */
export type Origin = AnchorStack & { n: number | null };

/** One thread's result in `lr review create --json`. */
export interface ReanchoredThread {
  id: number;
  anchorState: AnchorState;
  anchor: Anchor;
}

const UNSETTLED = new Set(["proposed", "open", "addressed"]);

/**
 * Whether a thread follows the code to each new round: unsettled threads do, and so do resolved
 * notes, since reviewers read them next to the code.
 */
function carried(t: Thread): boolean {
  return UNSETTLED.has(t.status) || (t.kind === "note" && t.status === "resolved");
}

/**
 * Carry the feature's unsettled threads and its notes onto a new round's snapshot. Resolved and
 * dismissed comments stay where they were; if one is reopened, the next round picks it up from
 * there. A note no round has picked up yet is placed from the stack it was written on.
 */
export async function reanchorThreads(input: {
  jj: Jj;
  store: Store;
  slug: string;
  round: Round;
  phases: Phase[];
}): Promise<ReanchoredThread[]> {
  const { store, slug, round } = input;
  const threads = store
    .listThreads(slug)
    .filter(
      (t) =>
        carried(t) && (t.anchorRound === null ? t.anchorStack !== null : t.anchorRound < round.n),
    );
  const reanchorer = new Reanchorer(input.jj, round, input.phases);
  const rounds = new Map<number, Round>();
  const placed: (Placement & { id: number })[] = [];
  for (const t of threads) {
    const n = t.anchorRound;
    if (n !== null && !rounds.has(n)) rounds.set(n, store.getRound(slug, n)!);
    const from: Origin = n === null ? { ...t.anchorStack!, n: null } : rounds.get(n)!;
    placed.push({ id: t.id, ...(await reanchorer.place(t, from)) });
  }
  store.placeThreads(slug, placed);
  return placed.map((p) => ({ id: p.id, anchorState: p.anchorState, anchor: p.anchor }));
}

/**
 * Maps anchors from the round they were made against onto a newer round. See "Re-anchoring" in
 * docs/design/data-model.md.
 */
export class Reanchorer {
  private readonly jj: Jj;
  private successors: Promise<Map<string, ChangeSnapshot>> | null = null;
  private readonly renamed = new Map<string, Promise<Map<string, string>>>();

  constructor(
    jj: Jj,
    private readonly to: Round,
    private readonly phases: Phase[],
  ) {
    this.jj = jj.at(to.jjOpId);
  }

  /** Where `thread`, anchored in `from`, stands in the new round. */
  async place(thread: Thread, from: Origin): Promise<Placement> {
    const a = thread.anchor;
    // Comments on final messages wait out code rounds, which have no messages to map them onto.
    if ((a.kind === "final" || a.kind === "pr_body") && !this.to.final) {
      return { anchor: a, anchorRound: from.n, anchorState: thread.anchorState };
    }
    const anchor = await this.follow(a, from);
    if (!anchor) return { anchor: thread.anchor, anchorRound: from.n, anchorState: "outdated" };
    const state = sameLocation(anchor, thread.originalAnchor) ? "current" : "moved";
    return { anchor, anchorRound: this.to.n, anchorState: state };
  }

  private async follow(a: Anchor, from: Origin): Promise<Anchor | null> {
    switch (a.kind) {
      case "feature":
        return a;
      case "phase":
        return this.phases.some((p) => p.id === a.phaseId) ? a : null;
      case "change": {
        const c = await this.change(a.changeId, from);
        return c && { kind: "change", changeId: c.changeId };
      }
      case "message":
        return this.message(a, from);
      case "code":
        return this.code(a, from);
      case "final": {
        const group = this.to.final!.groups.find((g) => g.id === a.groupId);
        const placed = group && followLines(splitLines(group.message), a.lines, a.snippet);
        return placed ? { ...a, ...placed } : null;
      }
      case "pr_body": {
        const placed = followLines(splitLines(this.to.final!.prBody), a.lines, a.snippet);
        return placed && { ...a, ...placed };
      }
    }
  }

  /**
   * The change in the new round that `changeId` (as it was in `from`) became: the same change, or
   * the one it was squashed into. null if it was abandoned.
   */
  private async change(changeId: string, from: Origin): Promise<ChangeSnapshot | null> {
    const same = this.to.changes.find((c) => c.changeId === changeId);
    if (same) return same;
    const old = from.changes.find((c) => c.changeId === changeId);
    return (old && (await this.successorsByCommit()).get(old.commitId)) ?? null;
  }

  /** Every earlier commit id → the new-round change whose evolution includes it. */
  private successorsByCommit(): Promise<Map<string, ChangeSnapshot>> {
    this.successors ??= (async () => {
      const logs = await Promise.all(this.to.changes.map((c) => this.jj.evolog(c.commitId)));
      const map = new Map<string, ChangeSnapshot>();
      for (const [i, c] of this.to.changes.entries()) {
        for (const id of logs[i]!) if (!map.has(id)) map.set(id, c);
      }
      return map;
    })();
    return this.successors;
  }

  private async message(a: MessageAnchor, from: Origin): Promise<MessageAnchor | null> {
    const c = await this.change(a.changeId, from);
    const placed = c && followLines(splitLines(c.description), a.lines, a.snippet);
    return placed ? { ...a, changeId: c!.changeId, commitId: c!.commitId, ...placed } : null;
  }

  private async code(a: CodeAnchor, from: Origin): Promise<CodeAnchor | null> {
    // Views keep their endpoints (by change id), so a comment stays in the diff it was made in.
    const end = a.view.to !== "base" && (await this.change(a.view.to.changeId, from));
    if (!end) return null;
    const endIndex = this.to.changes.indexOf(end);
    let startIndex = -1;
    if (a.view.from !== "base") {
      // A start that's gone, or no longer before the end, becomes the end's parent.
      const start = await this.change(a.view.from.changeId, from);
      const i = start ? this.to.changes.indexOf(start) : endIndex;
      startIndex = i < endIndex ? i : endIndex - 1;
    }
    const view = { from: refAt(this.to, startIndex), to: refAt(this.to, endIndex) };

    const oldRev = refCommit(from, a.side === "new" ? a.view.to : a.view.from);
    const newRev = refCommit(this.to, a.side === "new" ? view.to : view.from);
    const path = (await this.renames(oldRev, newRev)).get(a.path) ?? a.path;
    const lines =
      (await this.mapLines(oldRev, newRev, a.path, path, a.lines)) ??
      (await this.findSnippet(newRev, path, a.snippet));
    if (!lines) return null;

    const owner = (await this.change(a.changeId, from)) ?? end;
    return { ...a, view, changeId: owner.changeId, commitId: owner.commitId, path, lines };
  }

  /** Files renamed between two revisions (old path → new), fetched once per pair. */
  private renames(oldRev: string, newRev: string): Promise<Map<string, string>> {
    const key = `${oldRev}:${newRev}`;
    let found = this.renamed.get(key);
    if (!found) {
      found =
        oldRev === newRev
          ? Promise.resolve(new Map())
          : this.gone(this.jj.renames(oldRev, newRev), new Map());
      this.renamed.set(key, found);
    }
    return found;
  }

  /**
   * Map lines through the diff between two revisions (from `path` to `newPath`, if the file was
   * renamed); null if the diff touches them.
   */
  private async mapLines(
    oldRev: string,
    newRev: string,
    path: string,
    newPath: string,
    lines: [number, number],
  ): Promise<[number, number] | null> {
    if (oldRev === newRev) return lines;
    const hunks = await this.gone(this.jj.hunks(oldRev, newRev, path, newPath), null);
    return hunks && mapRange(hunks, lines);
  }

  /** `read`, or `fallback` if the old commit is gone for good (e.g. after `jj util gc`). */
  private async gone<T, F>(read: Promise<T>, fallback: F): Promise<T | F> {
    try {
      return await read;
    } catch (e) {
      if (e instanceof LrError) return fallback;
      throw e;
    }
  }

  /** The snippet's new position, if it appears exactly once in the file. */
  private async findSnippet(
    rev: string,
    path: string,
    snippet: string[],
  ): Promise<[number, number] | null> {
    if (!(await this.jj.isFile(rev, path))) return null;
    return findLines(splitLines(await this.jj.fileContent(rev, path)), snippet);
  }
}

/**
 * Where lines `[first, last]` of the old file end up in the new one, or null if any hunk changes
 * them (including an insertion between two of them). Hunks must be in file order.
 */
export function mapRange(hunks: Hunk[], [first, last]: [number, number]): [number, number] | null {
  let shift = 0;
  for (const h of hunks) {
    // A pure insertion sits after old line `oldStart`; anything else covers its old lines.
    const before = h.oldCount === 0 ? h.oldStart < first : h.oldStart + h.oldCount - 1 < first;
    const after = h.oldCount === 0 ? h.oldStart >= last : h.oldStart > last;
    if (after) break;
    if (!before) return null;
    shift += h.newCount - h.oldCount;
  }
  return [first + shift, last + shift];
}

/**
 * Where commented lines of a text (a message, the PR body) are now. A comment on the whole text
 * (`lines` null) is outdated by any change to it. Specific lines stay put if they're unchanged
 * there, or move to the one place they appear. null means outdated.
 */
function followLines(
  text: string[],
  lines: [number, number] | null,
  snippet: string[],
): { lines: [number, number] | null } | null {
  if (lines === null) return sameLines(text, snippet) ? { lines: null } : null;
  if (sameLines(text.slice(lines[0] - 1, lines[1]), snippet)) return { lines };
  const found = findLines(text, snippet);
  return found && { lines: found };
}

/** The 1-based range where `snippet` appears in `text`, if it appears exactly once. */
export function findLines(text: string[], snippet: string[]): [number, number] | null {
  if (snippet.length === 0) return null;
  let found: number | null = null;
  for (let i = 0; i + snippet.length <= text.length; i++) {
    if (sameLines(text.slice(i, i + snippet.length), snippet)) {
      if (found !== null) return null;
      found = i;
    }
  }
  return found === null ? null : [found + 1, found + snippet.length];
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** Same change and lines (or phase) as where the comment was made; commit ids don't count. */
function sameLocation(a: Anchor, b: Anchor): boolean {
  const key = (x: Anchor) =>
    x.kind === "code"
      ? [x.kind, x.changeId, x.path, x.side, x.lines]
      : x.kind === "message"
        ? [x.kind, x.changeId, x.lines]
        : x.kind === "final"
          ? [x.kind, x.groupId, x.lines]
          : x.kind === "pr_body"
            ? [x.kind, x.lines]
            : x;
  return JSON.stringify(key(a)) === JSON.stringify(key(b));
}
