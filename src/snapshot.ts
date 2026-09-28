import { LrError } from "./errors.ts";
import { type Jj, type JjCommit, revsetString } from "./jj.ts";
import type { ChangeSnapshot, Phase } from "./model.ts";

export interface Snapshot {
  jjOpId: string;
  baseCommitId: string;
  /** Ordered base → tip. */
  changes: ChangeSnapshot[];
  warnings: string[];
}

/**
 * Read the feature's stack from jj, pinned to a single operation so concurrent edits can't
 * produce a torn snapshot.
 *
 * The stack is everything between the base (fork point with `baseRevset`) and the top: the
 * last phase bookmark that exists, extended up to `@` if the working copy sits on top of it
 * (an empty, undescribed `@` is ignored). It must be linear.
 *
 * With `beforeBookmarks`, a stack with no phase bookmark yet runs up to `@`, as it does while the
 * first phase is being written.
 */
export async function takeSnapshot(
  live: Jj,
  baseRevset: string,
  phases: Phase[],
  opts: { beforeBookmarks?: boolean } = {},
): Promise<Snapshot> {
  const jjOpId = await live.snapshotOp();
  const jj = live.at(jjOpId);
  const warnings: string[] = [];

  // Where does each phase bookmark point?
  const bookmarkRevset = phases.map((p) => `present(${revsetString(p.bookmark)})`).join(" | ");
  const marked = await jj.commits(bookmarkRevset);
  const bookmarkTarget = new Map<string, JjCommit>();
  for (const c of marked) for (const b of c.bookmarks) bookmarkTarget.set(b, c);

  const present = phases.filter((p) => bookmarkTarget.has(p.bookmark));
  if (present.length === 0 && !opts.beforeBookmarks) {
    throw new LrError(
      `no phase bookmarks exist yet; create one when a phase is done, e.g.\n` +
        `  jj bookmark create ${phases[0]!.bookmark} -r <change>`,
    );
  }
  const missing = phases.filter((p) => !bookmarkTarget.has(p.bookmark));
  if (missing.length > 0) {
    warnings.push(
      `phases not started (no bookmark yet): ${missing.map((p) => `${p.id} ${p.bookmark}`).join(", ")}`,
    );
  }

  // With no bookmark yet, the stack runs from the base up to @.
  const topBookmark = present.length ? bookmarkTarget.get(present.at(-1)!.bookmark)! : null;
  let top = topBookmark ?? (await jj.single("@"));
  // Only descendants of the top bookmark count; if @ is elsewhere this is empty.
  const above = topBookmark
    ? await jj.commits(`(${topBookmark.commitId}::@) ~ ${topBookmark.commitId}`)
    : await jj.commits("@ | @-");
  if (above.length > 0) {
    // `above` is newest-first; skip the working copy if it's an empty, undescribed scratch commit.
    const [wc, ...rest] = above;
    const candidate = wc!.empty && wc!.description === "" ? rest[0] : wc;
    if (candidate) top = candidate;
  }

  const base = await jj.single(`heads(::${top.commitId} & ::(${baseRevset}))`);
  if (base.commitId === top.commitId) {
    const what = topBookmark ? present.at(-1)!.bookmark : "the working copy";
    throw new LrError(`stack is empty: ${what} is already in ${baseRevset}`);
  }

  // jj lists children before parents; we want base → tip.
  const stack = (await jj.commits(`${base.commitId}..${top.commitId}`)).reverse();

  let expectedParent = base.commitId;
  for (const c of stack) {
    if (c.parents.length !== 1 || c.parents[0] !== expectedParent) {
      throw new LrError(
        `stack must be linear, but change ${c.changeId.slice(0, 8)} has parents ` +
          `${c.parents.map((p) => p.slice(0, 8)).join(", ")} (expected ${expectedParent.slice(0, 8)})`,
      );
    }
    expectedParent = c.commitId;
  }

  // A present phase bookmark that isn't on the stack means the plan and the repo disagree.
  const inStack = new Set(stack.map((c) => c.commitId));
  for (const p of present) {
    if (!inStack.has(bookmarkTarget.get(p.bookmark)!.commitId)) {
      throw new LrError(
        `bookmark ${p.bookmark} (phase ${p.id}) points outside the stack ${base.commitId.slice(0, 8)}..${top.commitId.slice(0, 8)}`,
      );
    }
  }

  // Assign phases walking tip → base: a change belongs to the nearest phase bookmark at or above it.
  const phaseByBookmark = new Map(phases.map((p) => [p.bookmark, p]));
  const phaseIds: (number | null)[] = new Array(stack.length).fill(null);
  let current: Phase | null = null;
  for (let i = stack.length - 1; i >= 0; i--) {
    const own = stack[i]!.bookmarks.map((b) => phaseByBookmark.get(b)).filter(
      (p) => p !== undefined,
    );
    if (own.length > 1) {
      throw new LrError(
        `change ${stack[i]!.changeId.slice(0, 8)} has multiple phase bookmarks: ${own.map((p) => p.bookmark).join(", ")}`,
      );
    }
    if (own[0]) current = own[0];
    phaseIds[i] = current?.id ?? null;
  }

  // Phase bookmarks must appear in plan order going up the stack.
  const order = new Map(phases.map((p, i) => [p.id, i]));
  let last = -1;
  for (const id of phaseIds) {
    if (id === null) continue;
    const idx = order.get(id)!;
    if (idx < last)
      throw new LrError(
        `phase bookmarks are out of plan order in the stack (phase ${id} appears above a later phase)`,
      );
    last = idx;
  }

  const unassigned = stack.filter((_, i) => phaseIds[i] === null);
  if (unassigned.length > 0) {
    warnings.push(
      `${unassigned.length} change(s) above the last phase bookmark aren't in any phase: ` +
        unassigned.map((c) => c.changeId.slice(0, 8)).join(", "),
    );
  }
  const undescribed = stack.filter((c) => c.description.trim() === "");
  if (undescribed.length > 0) {
    warnings.push(
      `change(s) without a description: ${undescribed.map((c) => c.changeId.slice(0, 8)).join(", ")}`,
    );
  }

  return {
    jjOpId,
    baseCommitId: base.commitId,
    changes: stack.map((c, i) => ({
      changeId: c.changeId,
      commitId: c.commitId,
      description: c.description,
      trailers: c.trailers,
      phaseId: phaseIds[i]!,
      bookmarks: c.bookmarks,
      conflicted: c.conflict,
      empty: c.empty,
      stats: c.stats,
    })),
    warnings,
  };
}

/**
 * How stack `now` differs from stack `then` as code to review, e.g. `kxqpmnop's diff changed`.
 * What a clean rebase changes (commit ids, the base) doesn't count, so an empty result means a
 * review of `then` still holds for `now`.
 */
export async function codeChanges(
  jj: Jj,
  then: ChangeSnapshot[],
  now: ChangeSnapshot[],
): Promise<string[]> {
  const short = (id: string) => id.slice(0, 8);
  const thenIds = then.map((c) => c.changeId);
  const nowIds = now.map((c) => c.changeId);
  if (thenIds.join() !== nowIds.join()) {
    const parts = [
      ...nowIds.filter((id) => !thenIds.includes(id)).map((id) => `${short(id)} added`),
      ...thenIds.filter((id) => !nowIds.includes(id)).map((id) => `${short(id)} removed`),
    ];
    return [parts.length ? parts.join(", ") : "the changes were reordered"];
  }

  const found = await Promise.all(
    then.map(async (before, i) => {
      const after = now[i]!;
      const c = short(after.changeId);
      const diffs: string[] = [];
      if (after.commitId !== before.commitId) {
        // interdiff can't tell a conflict from its resolution, so a conflict always counts.
        if (after.conflicted) diffs.push(`${c} is conflicted`);
        else {
          const files = await jj.interdiffFiles(before.commitId, after.commitId);
          if (files.length) diffs.push(`${c}'s diff changed in ${files.join(", ")}`);
        }
        if (after.description !== before.description) diffs.push(`${c}'s message changed`);
      }
      if (after.phaseId !== before.phaseId) {
        diffs.push(
          `${c} moved from phase ${before.phaseId ?? "none"} to ${after.phaseId ?? "none"}`,
        );
      }
      return diffs;
    }),
  );
  return found.flat();
}
