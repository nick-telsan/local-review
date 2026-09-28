// What the web UI reads. Types here are the UI's API; web/ imports them.
import { join } from "node:path";
import { refAt } from "../anchors.ts";
import { nextStep } from "../commands/status.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import type {
  Actor,
  CheckRun,
  Feature,
  Phase,
  PlanVersion,
  Review,
  Round,
  Thread,
  ThreadStatus,
  Verdict,
} from "../model.ts";
import { type FileDiff, parsePatch } from "../patch.ts";

export interface RoundSummary {
  n: number;
  kind: Round["kind"];
  status: Round["status"];
  verdict: Verdict | null;
  createdAt: string;
}

export interface FeatureSummary {
  slug: string;
  title: string;
  status: Feature["status"];
  latestRound: RoundSummary | null;
  /** Threads waiting on someone: proposed, open, or addressed. */
  unsettled: number;
}

/** `GET /api/features` */
export interface FeaturesOk {
  root: string;
  /** Who the UI acts as. */
  actor: Actor;
  features: FeatureSummary[];
}

/**
 * Where a thread shows in a round:
 * - `line`: inline in its change's diff, at `lines` on `side`
 * - `aside`: listed with its change, not inline: made in a phase's combined diff (so its lines
 *   are the phase's), or outdated (the code it was on has changed)
 * - `gone`: its change isn't in the round any more (abandoned, or squashed away)
 * - the rest: on the feature, a phase, a change, a commit message, or the final round's texts
 */
export type Placement =
  | { on: "feature" }
  | { on: "phase"; phaseId: number }
  | { on: "change"; changeId: string }
  | { on: "message"; changeId: string; lines: [number, number] | null }
  | { on: "line"; changeId: string; path: string; side: "old" | "new"; lines: [number, number] }
  | { on: "aside"; changeId: string }
  | { on: "gone" }
  | { on: "final"; groupId: string; lines: [number, number] | null }
  | { on: "pr_body"; lines: [number, number] | null };

export interface ThreadView extends Thread {
  placement: Placement;
}

const UNSETTLED: ThreadStatus[] = ["proposed", "open", "addressed"];

/** `GET /api/features/:slug/rounds/:n` (`n` may be `latest`) */
export interface RoundView {
  actor: Actor;
  feature: Feature;
  /** What the feature is waiting on. */
  next: string;
  plan: PlanVersion | null;
  rounds: RoundSummary[];
  round: Round;
  latest: boolean;
  /** The phases as of the round's plan version. */
  phases: Phase[];
  checks: CheckRun[];
  reviews: Review[];
  /**
   * For the latest round: the threads placed in it, every unsettled one, and any with activity in it
   * (outdated threads stay anchored in the round where they were last found). For an earlier
   * round: the threads made in it, where they were made.
   */
  threads: ThreadView[];
}

/** `GET /api/features/:slug/rounds/:n/changes/:changeId` */
export interface ChangeView {
  changeId: string;
  commitId: string;
  files: FileDiff[];
}

export function features(ctx: Context): FeaturesOk {
  return {
    root: ctx.jj.root,
    actor: ctx.actor,
    features: ctx.store.listFeatures().map((f) => {
      const latest = ctx.store.latestRound(f.slug);
      const unsettled = ctx.store.listThreads(f.slug).filter((t) => UNSETTLED.includes(t.status));
      return {
        slug: f.slug,
        title: f.title,
        status: f.status,
        latestRound: latest && summary(latest),
        unsettled: unsettled.length,
      };
    }),
  };
}

export function roundView(ctx: Context, slug: string, n: string): RoundView {
  const feature = getFeature(ctx, slug);
  const round = ctx.round(feature, n === "latest" ? undefined : n);
  const latest = ctx.store.latestRound(slug)!;
  const rounds: RoundSummary[] = [];
  for (let i = 1; i <= latest.n; i++) rounds.push(summary(ctx.store.getRound(slug, i)!));

  const threads: ThreadView[] = [];
  for (const t of ctx.store.listThreads(slug)) {
    let at: Pick<Thread, "anchor" | "anchorState"> | null = null;
    if (round.n === latest.n) {
      // Outdated threads stay anchored where they were last found: show them while they still
      // need settling, and once settled, if that happened in this round.
      const carried =
        t.anchorRound !== null &&
        (UNSETTLED.includes(t.status) || t.entries.some((e) => e.round === round.n));
      if (t.anchorRound === round.n || carried) at = t;
    } else if (t.createdInRound === round.n) {
      at = { anchor: t.originalAnchor, anchorState: "current" };
    }
    if (at) threads.push({ ...t, ...at, placement: place(at, round) });
  }

  return {
    actor: ctx.actor,
    feature,
    next: nextStep(ctx, feature, latest),
    plan: feature.currentPlanVersion === null ? null : ctx.currentPlan(feature),
    rounds,
    round,
    latest: round.n === latest.n,
    phases: ctx.store.getPlanVersion(slug, round.planVersion)!.phases,
    checks: ctx.store.roundChecks(slug, round.n),
    reviews: ctx.store.listReviews(slug, round.n),
    threads,
  };
}

export async function changeView(
  ctx: Context,
  slug: string,
  n: string,
  changeId: string,
): Promise<ChangeView> {
  const feature = getFeature(ctx, slug);
  const round = ctx.round(feature, n);
  const change = round.changes.find((c) => c.changeId === changeId);
  if (!change) throw new LrError(`round ${round.n} has no change ${changeId}`);
  // Rounds cache each change's patch, in case jj has since dropped the commit.
  const cached = Bun.file(
    join(ctx.featureDir(slug), "rounds", String(round.n), "patches", `${changeId}.patch`),
  );
  const patch = (await cached.exists())
    ? await cached.text()
    : await ctx.jj.at(round.jjOpId).diffGit(change.commitId);
  return { changeId, commitId: change.commitId, files: parsePatch(patch) };
}

/** Where a thread shows, given its anchor in `round`. */
export function place(t: Pick<Thread, "anchor" | "anchorState">, round: Round): Placement {
  const a = t.anchor;
  if ("changeId" in a && !round.changes.some((c) => c.changeId === a.changeId)) {
    return { on: "gone" };
  }
  switch (a.kind) {
    case "feature":
      return { on: "feature" };
    case "phase":
      return { on: "phase", phaseId: a.phaseId };
    case "change":
      return { on: "change", changeId: a.changeId };
    case "message":
      return { on: "message", changeId: a.changeId, lines: a.lines };
    case "final":
      return { on: "final", groupId: a.groupId, lines: a.lines };
    case "pr_body":
      return { on: "pr_body", lines: a.lines };
    case "code": {
      // Inline only in the diff it was made in: the change's own, parent to change.
      const i = round.changes.findIndex((c) => c.changeId === a.changeId);
      const before = refAt(round, i - 1);
      const ownDiff =
        i >= 0 &&
        typeof a.view.to === "object" &&
        a.view.to.changeId === a.changeId &&
        (before === "base"
          ? a.view.from === "base"
          : typeof a.view.from === "object" && a.view.from.changeId === before.changeId);
      return ownDiff && t.anchorState !== "outdated"
        ? { on: "line", changeId: a.changeId, path: a.path, side: a.side, lines: a.lines }
        : { on: "aside", changeId: a.changeId };
    }
  }
}

function getFeature(ctx: Context, slug: string): Feature {
  const f = ctx.store.getFeature(slug);
  if (!f) throw new LrError(`no feature "${slug}" in this repo`);
  return f;
}

function summary(r: Round): RoundSummary {
  return { n: r.n, kind: r.kind, status: r.status, verdict: r.verdict, createdAt: r.createdAt };
}
