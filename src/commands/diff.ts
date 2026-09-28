import { formatActor } from "../actor.ts";
import { findChange } from "../anchors.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import type { Jj } from "../jj.ts";
import type { ChangeSnapshot, Feature, Round } from "../model.ts";
import { successorsByCommit } from "../reanchor.ts";

/** One change, compared between two rounds. */
export interface DiffChange {
  changeId: string;
  /**
   * `changed`: its diff, message, or phase changed. `unchanged` can still have a new commit id
   * (after a rebase). `removed`: abandoned, or squashed into another change (`squashedInto`).
   */
  status: "added" | "changed" | "unchanged" | "removed";
  /** As of the later round (the earlier one for a removed change). */
  description: string;
  phaseId: number | null;
  /** The phase in the earlier round, when the change moved phases. */
  movedFromPhase: number | null;
  fromCommitId: string | null;
  toCommitId: string | null;
  conflicted: boolean;
  /** Its message differs between the rounds (the patch shows how). */
  messageChanged: boolean;
  /**
   * `added`: the change's diff. `changed`: `jj interdiff --git` between its two commits, which
   * shows a message change as `JJ-COMMIT-DESCRIPTION`. Otherwise empty.
   */
  patch: string;
  /** The files in `patch`. */
  files: string[];
  squashedInto: string | null;
  /** Why the patch isn't what the status suggests, e.g. the earlier commit is gone. */
  note: string | null;
}

/** `lr diff --json` output. */
export interface DiffOk {
  from: number;
  to: number;
  /** `from` is the last round the actor reviewed (the default when there is one). */
  lastReviewed: boolean;
  /** The base commits, when the stack was rebased in between. */
  baseMoved: { from: string; to: string } | null;
  changes: DiffChange[];
}

/**
 * What changed between two rounds, change by change. Each change's diff is an interdiff, so what
 * landed on the base in between (a rebase) doesn't show. By default: the latest round against the
 * last one the actor reviewed, or else the one before it.
 */
export async function diff(
  ctx: Context,
  changeArg: string | undefined,
  opts: { from?: string; to?: string; nameOnly?: boolean },
): Promise<number> {
  const feature = ctx.feature();
  const to = ctx.round(feature, opts.to);
  const { from, lastReviewed } = fromRound(ctx, feature, to, opts.from);

  let changes = await compare(ctx.jj, from, to);
  if (changeArg !== undefined) {
    const stack = [...to.changes, ...from.changes.filter((c) => !has(to, c.changeId))];
    const wanted = findChange(stack, changeArg, `round ${from.n} or ${to.n}`).changeId;
    changes = changes.filter((c) => c.changeId === wanted);
  }
  const baseMoved =
    from.baseCommitId === to.baseCommitId ? null : { from: from.baseCommitId, to: to.baseCommitId };

  const json: DiffOk = { from: from.n, to: to.n, lastReviewed, baseMoved, changes };
  const plan = ctx.store.getPlanVersion(feature.slug, to.planVersion)!;
  ctx.print(json, render(json, plan.phases, opts.nameOnly ?? false));
  return 0;
}

/** `--from`, or the last round the actor reviewed before `to`, or the round before `to`. */
function fromRound(
  ctx: Context,
  feature: Feature,
  to: Round,
  requested: string | undefined,
): { from: Round; lastReviewed: boolean } {
  if (requested !== undefined) {
    const from = ctx.round(feature, requested);
    if (from.n >= to.n) {
      throw new LrError(`--from must be an earlier round than ${to.n}`);
    }
    return { from, lastReviewed: false };
  }
  if (to.n === 1) throw new LrError("round 1 is the first; there's no earlier round to compare");
  const me = formatActor(ctx.actor);
  for (let n = to.n - 1; n >= 1; n--) {
    const reviewed = ctx.store
      .listReviews(feature.slug, n)
      .some((r) => r.state === "submitted" && formatActor(r.reviewer) === me);
    if (reviewed) return { from: ctx.store.getRound(feature.slug, n)!, lastReviewed: true };
  }
  return { from: ctx.store.getRound(feature.slug, to.n - 1)!, lastReviewed: false };
}

const has = (round: Round, changeId: string) => round.changes.some((c) => c.changeId === changeId);

/** Every change in `to` (in stack order), then the ones `from` had that are gone. */
async function compare(jj: Jj, from: Round, to: Round): Promise<DiffChange[]> {
  const before = new Map(from.changes.map((c) => [c.changeId, c]));
  const kept = await Promise.all(to.changes.map((c) => compareOne(jj, before.get(c.changeId), c)));

  const gone = from.changes.filter((c) => !has(to, c.changeId));
  const successors = gone.length ? await successorsByCommit(jj, to.changes) : new Map();
  const removed = gone.map(
    (c): DiffChange => ({
      ...base(c),
      status: "removed",
      fromCommitId: c.commitId,
      squashedInto: successors.get(c.commitId)?.changeId ?? null,
    }),
  );
  return [...kept, ...removed];
}

function base(c: ChangeSnapshot): DiffChange {
  return {
    changeId: c.changeId,
    status: "unchanged",
    description: c.description,
    phaseId: c.phaseId,
    movedFromPhase: null,
    fromCommitId: null,
    toCommitId: null,
    conflicted: c.conflicted,
    messageChanged: false,
    patch: "",
    files: [],
    squashedInto: null,
    note: null,
  };
}

async function compareOne(
  jj: Jj,
  then: ChangeSnapshot | undefined,
  now: ChangeSnapshot,
): Promise<DiffChange> {
  const result: DiffChange = { ...base(now), toCommitId: now.commitId };
  if (!then) {
    const [patch, files] = await Promise.all([
      jj.diffGit(now.commitId),
      jj.diffFiles(now.commitId),
    ]);
    return { ...result, status: "added", patch, files };
  }
  result.fromCommitId = then.commitId;
  if (then.phaseId !== now.phaseId) result.movedFromPhase = then.phaseId;
  result.messageChanged = then.description !== now.description;
  if (then.commitId !== now.commitId) {
    try {
      [result.patch, result.files] = await Promise.all([
        jj.interdiff(then.commitId, now.commitId),
        jj.interdiffFiles(then.commitId, now.commitId),
      ]);
    } catch (e) {
      // The earlier commit can be gone for good (e.g. after `jj util gc`).
      if (!(e instanceof LrError)) throw e;
      [result.patch, result.files] = await Promise.all([
        jj.diffGit(now.commitId),
        jj.diffFiles(now.commitId),
      ]);
      result.note = "the earlier commit is gone, so this is the whole change";
    }
  }
  // interdiff can't tell a conflict from its resolution, so a conflict always counts.
  const changed =
    result.patch !== "" || now.conflicted || then.phaseId !== now.phaseId || result.note !== null;
  return { ...result, status: changed ? "changed" : "unchanged" };
}

function render(
  d: DiffOk,
  phases: { id: number; title: string; bookmark: string }[],
  nameOnly: boolean,
): string[] {
  const count = (status: DiffChange["status"]) => d.changes.filter((c) => c.status === status);
  const tally = (["changed", "added", "removed", "unchanged"] as const)
    .map((s) => [count(s).length, s] as const)
    .filter(([n]) => n > 0)
    .map(([n, s]) => `${n} ${s}`)
    .join(", ");
  const lines = [
    `Round ${d.from}${d.lastReviewed ? " (your last review)" : ""} → round ${d.to}: ` +
      (tally || "no changes"),
  ];
  if (d.baseMoved) {
    lines.push(
      `Rebased (base ${d.baseMoved.from.slice(0, 8)} → ${d.baseMoved.to.slice(0, 8)}); ` +
        "what landed on the base isn't shown.",
    );
  }

  let heading: string | null = null;
  let spaced = false;
  for (const c of d.changes) {
    const p = phases.find((x) => x.id === c.phaseId);
    const next =
      c.status === "removed"
        ? "Removed:"
        : p
          ? `Phase ${p.id}: ${p.title} [${p.bookmark}]`
          : "Unassigned:";
    // A blank line after each heading, and around each change that shows a patch.
    const patched = !nameOnly && c.patch !== "";
    if (next !== heading) {
      lines.push("", next);
      heading = next;
    } else if (spaced || patched) lines.push("");
    spaced = patched;
    lines.push(...renderChange(c, nameOnly));
  }
  return lines;
}

function renderChange(c: DiffChange, nameOnly: boolean): string[] {
  const subject = c.description.split("\n")[0] || "(no description)";
  const notes: string[] = [c.status];
  if (c.movedFromPhase !== null) notes.push(`moved from phase ${c.movedFromPhase}`);
  if (c.conflicted) notes.push("conflicted");
  if (c.messageChanged) notes.push("message edited");
  if (c.squashedInto) notes.push(`squashed into ${c.squashedInto.slice(0, 8)}`);
  if (c.note) notes.push(c.note);
  const lines = [`  ${c.changeId.slice(0, 8)}  ${subject}  (${notes.join("; ")})`];
  if (nameOnly) return [...lines, ...c.files.map((f) => `      ${f}`)];
  // A new change's full message, when there's more to it than the subject.
  const message = c.description.trimEnd().split("\n");
  if (c.status === "added" && message.length > 1) lines.push(...message.map((l) => `    | ${l}`));
  if (c.patch) lines.push("", c.patch.trimEnd());
  return lines;
}
