import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import { FINAL_STATUSES } from "../final.ts";
import type { ChangeSnapshot, Feature, Round } from "../model.ts";
import { takeSnapshot } from "../snapshot.ts";
import { describeStack } from "./review.ts";

/** `lr rebase --json` output. */
export interface RebaseOk {
  /** False when the stack was already on the target, so nothing moved. */
  rebased: boolean;
  /** What the stack was rebased onto. `revset` is the feature's base from now on. */
  onto: { revset: string; commitId: string };
  /** The stack's base commit before. */
  fromBase: string;
  /** Undo point: `jj op restore <opBefore>` puts the stack back. */
  opBefore: string;
  opAfter: string;
  /** The stack after, base → tip. */
  changes: ChangeSnapshot[];
  /** Change ids the rebase left conflicted. */
  conflicted: string[];
  next: string;
}

/**
 * Rebase the feature's stack onto its base, or onto `--onto`, which becomes its base. lr's state
 * needs nothing else: rounds are snapshots that keep the commits they were taken from, the next
 * round re-anchors threads and reruns checks on the new commits, and an approval carries over as
 * long as each change's own diff is unchanged (see `codeChanges`). A plain `jj rebase` is handled
 * the same way.
 */
export async function rebase(ctx: Context, opts: { onto?: string }): Promise<number> {
  const feature = ctx.feature();
  if (feature.status === "done" || feature.status === "abandoned") {
    throw new LrError(`feature "${feature.slug}" is ${feature.status}`);
  }
  const plan = ctx.currentPlan(feature);
  const revset = opts.onto ?? feature.baseRevset;
  const before = await takeSnapshot(ctx.jj, feature.baseRevset, plan.phases);
  const target = await ctx.jj.at(before.jjOpId).single(revset);
  if (before.changes.some((c) => c.commitId === target.commitId)) {
    throw new LrError(`${revset} is in the stack itself; rebase onto a commit outside it`);
  }

  const rebased = target.commitId !== before.baseCommitId;
  if (rebased) await ctx.jj.rebase(before.changes[0]!.changeId, target.commitId);
  // Read the result against the commit itself, in case the revset moved with the stack.
  const after = rebased ? await takeSnapshot(ctx.jj, target.commitId, plan.phases) : before;
  if (opts.onto !== undefined && opts.onto !== feature.baseRevset) {
    ctx.store.setBaseRevset(feature.slug, opts.onto);
  }

  const conflicted = after.changes.filter((c) => c.conflicted);
  const round = ctx.store.latestRound(feature.slug);
  const json: RebaseOk = {
    rebased,
    onto: { revset, commitId: target.commitId },
    fromBase: before.baseCommitId,
    opBefore: before.jjOpId,
    opAfter: after.jjOpId,
    changes: after.changes,
    conflicted: conflicted.map((c) => c.changeId),
    next: nextStep(feature, round, rebased, conflicted.length > 0),
  };
  const short = (id: string) => id.slice(0, 8);
  const lines = rebased
    ? [
        `Rebased ${feature.slug} onto ${revset} (${short(target.commitId)}, was ` +
          `${short(before.baseCommitId)}): ${after.changes.length} changes`,
        ...describeStack(after.changes, plan.phases).map((l) => `  ${l}`),
      ]
    : [`${feature.slug} is already on ${revset} (${short(target.commitId)}); nothing to rebase.`];
  if (revset !== feature.baseRevset) lines.push(`The feature's base is now ${revset}.`);
  if (conflicted.length) {
    lines.push(
      `Conflicted: ${conflicted.length} change${conflicted.length === 1 ? "" : "s"} (` +
        `${conflicted.map((c) => short(c.changeId)).join(", ")})`,
    );
  }
  if (rebased) lines.push(`Undo with \`jj op restore ${before.jjOpId.slice(0, 12)}\`.`);
  lines.push(`Next: ${json.next}`);
  ctx.print(json, lines);
  return 0;
}

function nextStep(
  feature: Feature,
  round: Round | null,
  rebased: boolean,
  conflicted: boolean,
): string {
  const approved = FINAL_STATUSES.includes(feature.status);
  if (conflicted) {
    return (
      "resolve each conflict in the change where it appears (`jj edit <change>`), then " +
      "`lr review create`" +
      (approved ? ". Resolving them changes code a human approved, so it needs a code round." : "")
    );
  }
  if (!rebased) return "nothing";
  if (feature.status === "in_review" && round) {
    return (
      `round ${round.n} still shows the stack as it was, and reviews of it still count; ` +
      "`lr review create` puts the rebased stack up for review instead"
    );
  }
  if (feature.status === "finalizing") {
    return (
      "a clean rebase keeps the approval, so carry on finalizing; `lr review create --final` " +
      "runs the checks on the rebased stack"
    );
  }
  if (approved) {
    return "a clean rebase keeps the approval; `lr final apply` runs the checks on the rebased stack first";
  }
  return "carry on; the next `lr review create` runs the checks on the rebased stack";
}
