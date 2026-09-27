import { refAt, refCommit, splitLines } from "./anchors.ts";
import { LrError } from "./errors.ts";
import type { Hunk, Jj } from "./jj.ts";
import type { Anchor, AnchorState, ChangeSnapshot, Phase, Round, Thread } from "./model.ts";
import type { Store } from "./store.ts";

type CodeAnchor = Extract<Anchor, { kind: "code" }>;
type MessageAnchor = Extract<Anchor, { kind: "message" }>;

/** Where a thread landed in a new round. Outdated threads keep their last good anchor and round. */
export interface Placement {
  anchor: Anchor;
  anchorRound: number;
  anchorState: AnchorState;
}

/** One thread's result in `lr review create --json`. */
export interface ReanchoredThread {
  id: number;
  anchorState: AnchorState;
  anchor: Anchor;
}

const UNSETTLED = new Set(["proposed", "open", "addressed"]);

/**
 * Carry the feature's unsettled threads onto a new round's snapshot. Resolved and dismissed
 * threads stay where they were; if one is reopened, the next round picks it up from there.
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
    .filter((t) => UNSETTLED.has(t.status) && t.anchorRound !== null && t.anchorRound < round.n);
  const reanchorer = new Reanchorer(input.jj, round, input.phases);
  const rounds = new Map<number, Round>();
  const placed: (Placement & { id: number })[] = [];
  for (const t of threads) {
    const n = t.anchorRound!;
    if (!rounds.has(n)) rounds.set(n, store.getRound(slug, n)!);
    placed.push({ id: t.id, ...(await reanchorer.place(t, rounds.get(n)!)) });
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

  constructor(
    jj: Jj,
    private readonly to: Round,
    private readonly phases: Phase[],
  ) {
    this.jj = jj.at(to.jjOpId);
  }

  /** Where `thread`, anchored in `from`, stands in the new round. */
  async place(thread: Thread, from: Round): Promise<Placement> {
    const anchor = await this.follow(thread.anchor, from);
    if (!anchor) return { anchor: thread.anchor, anchorRound: from.n, anchorState: "outdated" };
    const state = sameLocation(anchor, thread.originalAnchor) ? "current" : "moved";
    return { anchor, anchorRound: this.to.n, anchorState: state };
  }

  private async follow(a: Anchor, from: Round): Promise<Anchor | null> {
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
    }
  }

  /**
   * The change in the new round that `changeId` (as it was in `from`) became: the same change, or
   * the one it was squashed into. null if it was abandoned.
   */
  private async change(changeId: string, from: Round): Promise<ChangeSnapshot | null> {
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

  private async message(a: MessageAnchor, from: Round): Promise<MessageAnchor | null> {
    const c = await this.change(a.changeId, from);
    if (!c) return null;
    const text = splitLines(c.description);
    let lines = a.lines;
    if (lines === null) {
      // A comment on the whole message is outdated by any rewording.
      if (!sameLines(text, a.snippet)) return null;
    } else if (!sameLines(text.slice(lines[0] - 1, lines[1]), a.snippet)) {
      lines = findLines(text, a.snippet);
      if (!lines) return null;
    }
    return { ...a, changeId: c.changeId, commitId: c.commitId, lines };
  }

  private async code(a: CodeAnchor, from: Round): Promise<CodeAnchor | null> {
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
    const lines =
      (await this.mapLines(oldRev, newRev, a.path, a.lines)) ??
      (await this.findSnippet(newRev, a.path, a.snippet));
    if (!lines) return null;

    const owner = (await this.change(a.changeId, from)) ?? end;
    return { ...a, view, changeId: owner.changeId, commitId: owner.commitId, lines };
  }

  /** Map lines through the diff between two revisions; null if the diff touches them. */
  private async mapLines(
    oldRev: string,
    newRev: string,
    path: string,
    lines: [number, number],
  ): Promise<[number, number] | null> {
    if (oldRev === newRev) return lines;
    try {
      return mapRange(await this.jj.hunks(oldRev, newRev, path), lines);
    } catch (e) {
      // The old commit can be gone for good (e.g. after `jj util gc`).
      if (e instanceof LrError) return null;
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
        : x;
  return JSON.stringify(key(a)) === JSON.stringify(key(b));
}
