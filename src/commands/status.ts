import type { Context } from "../context.ts";
import type { FeatureStatus } from "../model.ts";
import { describeStack } from "./review.ts";

const NEXT: Record<FeatureStatus, string> = {
  planning: "write a plan: `lr plan submit -F <file>`",
  implementing:
    "implement the plan (one commit per task, a bookmark per phase), then `lr review create`",
  in_review: "waiting on reviews",
  revising: "apply the revised plan, then `lr review create`",
  finalizing: "draft final commit messages and the PR body",
  final_review: "waiting on final review",
  done: "nothing — feature is done",
  abandoned: "nothing — feature was abandoned",
};

export async function status(ctx: Context): Promise<number> {
  const feature = ctx.feature();
  const plan = feature.currentPlanVersion !== null ? ctx.currentPlan(feature) : null;
  const round = ctx.store.latestRound(feature.slug);
  const checks = round ? ctx.store.roundChecks(feature.slug, round.n) : [];

  const lines = [
    `${feature.slug}: ${feature.title}`,
    `Status: ${feature.status}`,
    `Plan: ${plan ? `v${plan.version}` : "none"}`,
  ];
  if (round) {
    // Phases as they were when the round was taken; the plan may have been revised since.
    const roundPlan = ctx.store.getPlanVersion(feature.slug, round.planVersion)!;
    lines.push(
      `Round ${round.n} (${round.status}, plan v${round.planVersion}), ${round.changes.length} changes:`,
    );
    lines.push(...describeStack(round.changes, roundPlan.phases).map((l) => `  ${l}`));
    if (checks.length) {
      lines.push("Checks:");
      for (const c of checks)
        lines.push(`  ${c.status.padEnd(6)} ${c.check} @ ${c.changeId.slice(0, 8)}`);
    }
  }
  lines.push(`Next: ${NEXT[feature.status]}`);

  ctx.print({ feature, plan, round, checks, next: NEXT[feature.status] }, lines);
  return 0;
}
