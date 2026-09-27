import { join } from "node:path";
import { AnchorResolver, describeAnchor } from "../anchors.ts";
import { loadRepoConfig } from "../config.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import { Drafts } from "../final.ts";
import type { Anchor, Feature, Review, Round, Thread } from "../model.ts";
import { parseSubmission } from "../submission.ts";

/** `lr review submit --json` output. */
export interface ReviewSubmitOk {
  review: Review;
  threads: Thread[];
}

/**
 * Submit a whole review at once: a verdict, a summary, and comments, from a JSON file (the agent
 * path) and/or flags. Every comment location is validated against the round's snapshot, and
 * nothing is recorded unless all of them resolve.
 */
export async function reviewSubmit(
  ctx: Context,
  opts: { file?: string; round?: string; verdict?: string; body?: string },
): Promise<number> {
  if (!opts.file && !opts.verdict && !opts.body) {
    throw new LrError(
      "usage: lr review submit [-F <review.json>] [--verdict approved|changes_requested] [-m <body>] [--round <n>]",
    );
  }
  const feature = ctx.feature();

  const data: Record<string, unknown> = opts.file ? await readJson(ctx, opts.file) : {};
  if (opts.verdict) data.verdict = opts.verdict;
  if (opts.body) data.body = opts.body;
  const submission = parseSubmission(data);

  const round = pickRound(ctx, feature, opts.round);
  // A human approves exactly what the final round froze; later edits need a new final round.
  if (round.final && submission.verdict === "approved" && ctx.actor.kind === "human") {
    const changed = new Drafts(join(ctx.featureDir(feature.slug), "final")).changedSince(
      round.final,
    );
    if (changed.length) {
      throw new LrError(
        `the drafts changed since final round ${round.n} opened (${changed.join(", ")}); run ` +
          "`lr review create --final` so the approval covers them",
      );
    }
  }
  const plan = ctx.store.getPlanVersion(feature.slug, round.planVersion)!;
  const resolver = new AnchorResolver(ctx.jj, round, plan.phases);

  const anchors: Anchor[] = [];
  const problems: string[] = [];
  for (const [i, c] of submission.comments.entries()) {
    try {
      anchors.push(await resolver.resolve(c));
    } catch (e) {
      if (!(e instanceof LrError)) throw e;
      problems.push(`comments[${i}]: ${e.message}`);
    }
  }
  if (problems.length > 0) {
    throw new LrError(`review not recorded:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  const { review: config } = await loadRepoConfig(ctx.jj.root);
  const status = ctx.actor.kind === "agent" && config.triageAgentComments ? "proposed" : "open";
  const { review, threads } = ctx.store.submitReview(feature.slug, {
    round: round.n,
    reviewer: ctx.actor,
    verdict: submission.verdict,
    body: submission.body,
    comments: submission.comments.map((c, i) => ({
      anchor: anchors[i]!,
      severity: c.severity,
      body: c.body,
      suggestion: c.suggestion,
      status,
    })),
  });

  const json: ReviewSubmitOk = { review, threads };
  const who = `${review.reviewer.kind}:${review.reviewer.name}`;
  ctx.print(json, [
    `Review recorded on round ${round.n} by ${who}: ${review.verdict?.replace("_", " ") ?? "comments only"}`,
    ...threads.map(
      (t) => `  #${t.id} ${(t.severity ?? "").padEnd(10)} ${describeAnchor(t.anchor)}`,
    ),
    ...(status === "proposed" && threads.length > 0
      ? [`${threads.length} comment(s) await triage by a human (review.triage_agent_comments)`]
      : []),
  ]);
  return 0;
}

/** The requested round, or the latest one; it must still be open. */
function pickRound(ctx: Context, feature: Feature, requested: string | undefined): Round {
  const round = ctx.round(feature, requested);
  if (round.status === "superseded") {
    const latest = ctx.round(feature);
    throw new LrError(`round ${round.n} was superseded; review round ${latest.n} instead`);
  }
  if (round.status !== "open") throw new LrError(`round ${round.n} is ${round.status}`);
  return round;
}

async function readJson(ctx: Context, path: string): Promise<Record<string, unknown>> {
  const text = await ctx.readInput(path);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new LrError(
      `${path === "-" ? "stdin" : path} is not valid JSON: ${(e as Error).message}`,
    );
  }
}
