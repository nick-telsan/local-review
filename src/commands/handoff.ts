import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import { buildHandoff, type HandoffResult, renderHandoff } from "../handoff.ts";
import type { Feature, Round } from "../model.ts";

/** Everything the author needs after a review round, as markdown (or --json). Read-only. */
export async function handoff(ctx: Context, opts: { round?: string }): Promise<number> {
  const feature = ctx.feature();
  const result = loadHandoff(ctx, feature, ctx.round(feature, opts.round));
  if (!result.ready) {
    if (ctx.json) {
      ctx.print(result, "");
      return 1;
    }
    throw new LrError(`nothing to hand off: ${result.reason}`);
  }
  if (ctx.json) ctx.print({ ready: true, ...result.handoff }, "");
  else ctx.io.out(renderHandoff(result.handoff));
  return 0;
}

export function loadHandoff(ctx: Context, feature: Feature, round: Round): HandoffResult {
  return buildHandoff({
    feature,
    round,
    phases: ctx.store.getPlanVersion(feature.slug, round.planVersion)!.phases,
    reviews: ctx.store.listReviews(feature.slug, round.n),
    checks: ctx.store.roundChecks(feature.slug, round.n),
    threads: ctx.store.listThreads(feature.slug),
  });
}
