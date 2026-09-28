import type { Context } from "../context.ts";
import { describeGap, type PlanGap, planGaps } from "../coverage.ts";
import type {
  CheckRun,
  Feature,
  FeatureStatus,
  PlanVersion,
  Review,
  Round,
  Thread,
} from "../model.ts";
import { loadHandoff } from "./handoff.ts";
import { describeStack } from "./review.ts";

const NEXT: Record<FeatureStatus, string> = {
  planning: "write a plan: `lr plan submit -F <file>`",
  implementing:
    "implement the plan (one commit per task, a bookmark per phase), then `lr review create`",
  in_review: "waiting on reviews",
  revising: "work through `lr handoff`, then `lr review create`",
  finalizing:
    "address any open threads in `lr handoff`, then draft the final commits (`lr final show`) " +
    "and run `lr review create --final`",
  final_review: "waiting on final review",
  approved: "run `lr final apply` to squash the stack",
  done: "push the stack and open the PR; once it lands, `lr feature clean` forgets its bookmarks",
  abandoned: "nothing; `lr feature clean` forgets its bookmarks and check workspace",
};

/** `lr status --json` output. */
export interface StatusOk {
  feature: Feature;
  plan: PlanVersion | null;
  round: Round | null;
  checks: CheckRun[];
  reviews: Review[];
  threads: Thread[];
  /** Where the latest code round and its plan don't line up (see `planGaps`). */
  planGaps: PlanGap[];
  next: string;
}

export async function status(ctx: Context): Promise<number> {
  const feature = ctx.feature();
  const plan = feature.currentPlanVersion !== null ? ctx.currentPlan(feature) : null;
  const round = ctx.store.latestRound(feature.slug);
  const checks = round ? ctx.store.roundChecks(feature.slug, round.n) : [];
  const reviews = round ? ctx.store.listReviews(feature.slug, round.n) : [];
  const threads = ctx.store.listThreads(feature.slug);
  let gaps: PlanGap[] = [];

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
    // A final round's code is already approved, so gaps are moot there.
    if (round.kind === "code") gaps = planGaps(round, roundPlan.phases);
    if (gaps.length) {
      lines.push(`Plan gaps (Plan-Task trailers vs plan v${round.planVersion}):`);
      for (const g of gaps) lines.push(`  ${describeGap(g, round.changes)}`);
    }
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
  // A resolved note is just there to read; one that's been reopened counts like a comment.
  const live = threads.filter((t) => t.kind === "comment" || t.status !== "resolved");
  const byStatus = Object.entries(Object.groupBy(live, (t) => t.status)).map(
    ([s, ts]) => `${ts!.length} ${s}`,
  );
  if (byStatus.length) lines.push(`Threads: ${byStatus.join(", ")}`);
  const notes = threads.filter((t) => t.kind === "note").length;
  if (notes) lines.push(`Notes: ${notes} (\`lr threads --notes\`)`);
  const next = nextStep(ctx, feature, round);
  lines.push(`Next: ${next}`);

  const ok: StatusOk = { feature, plan, round, checks, reviews, threads, planGaps: gaps, next };
  ctx.print(ok, lines);
  return 0;
}

/** What the feature is waiting on, as a short instruction. */
export function nextStep(ctx: Context, feature: Feature, round: Round | null): string {
  // Agent reviewers can hand work back before any human verdict moves the feature along.
  return feature.status === "in_review" && round && loadHandoff(ctx, feature, round).ready
    ? "agent reviewers requested changes: read `lr handoff`"
    : NEXT[feature.status];
}
