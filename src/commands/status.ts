import type { Context } from "../context.ts";
import type { FeatureStatus } from "../model.ts";
import { loadHandoff } from "./handoff.ts";
import { describeStack } from "./review.ts";

const NEXT: Record<FeatureStatus, string> = {
  planning: "write a plan: `lr plan submit -F <file>`",
  implementing:
    "implement the plan (one commit per task, a bookmark per phase), then `lr review create`",
  in_review: "waiting on reviews",
  revising: "work through `lr handoff`, then `lr review create`",
  finalizing: "address any open threads in `lr handoff`; finalization isn't in lr yet",
  final_review: "waiting on final review",
  done: "nothing — feature is done",
  abandoned: "nothing — feature was abandoned",
};

export async function status(ctx: Context): Promise<number> {
  const feature = ctx.feature();
  const plan = feature.currentPlanVersion !== null ? ctx.currentPlan(feature) : null;
  const round = ctx.store.latestRound(feature.slug);
  const checks = round ? ctx.store.roundChecks(feature.slug, round.n) : [];
  const reviews = round ? ctx.store.listReviews(feature.slug, round.n) : [];
  const threads = ctx.store.listThreads(feature.slug);

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
    if (reviews.length) {
      lines.push("Reviews:");
      for (const r of reviews) {
        const count = threads.filter((t) => t.reviewId === r.id).length;
        lines.push(
          `  ${`${r.reviewer.kind}:${r.reviewer.name}`.padEnd(20)} ` +
            `${(r.verdict ?? "commented").padEnd(17)} ${count} comment(s)`,
        );
      }
    }
  }
  const byStatus = Object.entries(Object.groupBy(threads, (t) => t.status)).map(
    ([s, ts]) => `${ts!.length} ${s}`,
  );
  if (byStatus.length) lines.push(`Threads: ${byStatus.join(", ")}`);
  // Agent reviewers can hand work back before any human verdict moves the feature along.
  const next =
    feature.status === "in_review" && round && loadHandoff(ctx, feature, round).ready
      ? "agent reviewers requested changes: read `lr handoff`"
      : NEXT[feature.status];
  lines.push(`Next: ${next}`);

  ctx.print({ feature, plan, round, checks, reviews, threads, next }, lines);
  return 0;
}
