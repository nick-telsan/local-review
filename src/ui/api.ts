// What the web UI reads. Types here are the UI's API; src/web/ imports them.
import { join } from "node:path";
import { refAt } from "../anchors.ts";
import { compare, type DiffChange, type DiffOk, lastReviewedBefore } from "../commands/diff.ts";
import { nextStep } from "../commands/status.ts";
import {
  pickRound,
  type ReviewSubmitOk,
  recordReview,
  resolveComment,
} from "../commands/submit.ts";
import { allowedActions, applyReply, type ReplyAction, type ReplyOk } from "../commands/thread.ts";
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
  Severity,
  Task,
  Thread,
  ThreadStatus,
  Verdict,
} from "../model.ts";
import { type FileDiff, parsePatch } from "../patch.ts";
import { parsePlan } from "../plan.ts";

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
  /** What the UI's actor may do to it now. */
  actions: ReplyAction[];
}

/** A comment in a draft review, in review-file form (see "Review submissions" in the design). */
export interface DraftCommentInput {
  change?: string;
  path?: string;
  lines?: [number, number];
  side?: "old" | "new";
  message?: boolean;
  /** A phase: its combined diff with `path`, or the phase itself without. */
  phase?: number;
  /** A final commit's group id (final rounds). */
  final?: string;
  /** The PR body (final rounds). */
  pr_body?: boolean;
  severity?: Severity | null;
  body: string;
  suggestion?: string | null;
}

export interface DraftComment {
  id: string;
  comment: DraftCommentInput;
  /** Where it shows, checked against the round when it was added. */
  placement: Placement;
}

/** The UI's actor's unsubmitted review of a round. Nobody else sees it. */
export interface ReviewDraft {
  round: number;
  verdict: Verdict | null;
  body: string | null;
  comments: DraftComment[];
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
  /** The actor's draft review of this round, if any. */
  draft: ReviewDraft | null;
  /** Other rounds where the actor has a draft (e.g. one superseded while they wrote it). */
  otherDrafts: number[];
  /** The latest earlier round the actor reviewed: what "since your last review" compares with. */
  lastReviewed: number | null;
}

/** `GET /api/features/:slug/rounds/:n/changes/:changeId` */
export interface ChangeView {
  changeId: string;
  commitId: string;
  files: FileDiff[];
}

/** A plan version, with its markdown. */
export interface PlanText {
  plan: PlanVersion;
  /** The whole file, frontmatter included. */
  text: string;
  /** The markdown after the frontmatter. */
  body: string;
}

/** A task, and the changes that say they implement it (`Plan-Task: <id>`), in stack order. */
export interface TaskCoverage {
  task: Task;
  changeIds: string[];
}

export interface PhaseCoverage {
  phaseId: number;
  tasks: TaskCoverage[];
  /** The changes in the phase (by its bookmark), in stack order. */
  changeIds: string[];
  /** Changes in the phase that name no task. */
  untasked: string[];
}

/** How the round's changes line up with its plan. */
export interface PlanCoverage {
  phases: PhaseCoverage[];
  /** Changes naming a task the plan doesn't have. */
  unknownTasks: { changeId: string; taskId: string }[];
  /** Changes past the last phase's bookmark. */
  unphased: string[];
  /** Whether any change names a task: without that, there's no coverage to show. */
  linked: boolean;
}

/** `GET /api/features/:slug/rounds/:n/plan` */
export interface PlanView {
  /** The version the round was taken against. */
  version: number;
  /** Every version, oldest first. */
  versions: PlanText[];
  coverage: PlanCoverage;
}

/** One change, compared with the earlier round (see `DiffChange`, which is `lr diff`'s). */
export interface SinceChange extends Omit<DiffChange, "patch" | "files"> {
  /**
   * For a `changed` change: how its diff changed, as an interdiff. Its new side is the change's
   * own new side, so those lines take comments; its old side is the earlier commit, rebased. Empty
   * otherwise: an added change's diff (or one whose earlier commit is gone) is its whole diff.
   */
  files: FileDiff[];
  /** How its message changed, as a diff of the two messages. */
  message: FileDiff | null;
}

/** `GET /api/features/:slug/rounds/:n/since/:from`: what changed since an earlier round. */
export interface SinceView extends Omit<DiffOk, "lastReviewed" | "changes"> {
  changes: SinceChange[];
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
    if (at) {
      threads.push({
        ...t,
        ...at,
        placement: place(at, round),
        actions: allowedActions(ctx.actor, t),
      });
    }
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
    draft: ctx.store.getDraft<ReviewDraft>(slug, round.n, ctx.actor),
    otherDrafts: ctx.store.draftRounds(slug, ctx.actor).filter((r) => r !== round.n),
    lastReviewed: lastReviewedBefore(ctx, feature, round.n)?.n ?? null,
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

export async function planView(ctx: Context, slug: string, n: string): Promise<PlanView> {
  const feature = getFeature(ctx, slug);
  const round = ctx.round(feature, n === "latest" ? undefined : n);
  const versions: PlanText[] = [];
  for (let v = 1; v <= (feature.currentPlanVersion ?? 0); v++) {
    const plan = ctx.store.getPlanVersion(slug, v)!;
    const text = await Bun.file(join(ctx.featureDir(slug), plan.path)).text();
    versions.push({ plan, text, body: parsePlan(text, slug).body });
  }
  const phases = ctx.store.getPlanVersion(slug, round.planVersion)!.phases;
  return { version: round.planVersion, versions, coverage: coverage(round, phases) };
}

/** The task ids a change names in `Plan-Task` trailers (`1.1`, or several: `1.1, 1.2`). */
function taskIds(change: Round["changes"][number]): string[] {
  return change.trailers
    .filter(([key]) => key.toLowerCase() === "plan-task")
    .flatMap(([, value]) => value.split(/[\s,]+/))
    .filter(Boolean);
}

function coverage(round: Round, phases: Phase[]): PlanCoverage {
  const known = new Set(phases.flatMap((p) => p.tasks.map((t) => t.id)));
  const named = round.changes.map((c) => ({ id: c.changeId, tasks: taskIds(c), phase: c.phaseId }));
  return {
    phases: phases.map((p) => {
      const inPhase = named.filter((c) => c.phase === p.id);
      return {
        phaseId: p.id,
        tasks: p.tasks.map((task) => ({
          task,
          changeIds: named.filter((c) => c.tasks.includes(task.id)).map((c) => c.id),
        })),
        changeIds: inPhase.map((c) => c.id),
        untasked: inPhase.filter((c) => c.tasks.length === 0).map((c) => c.id),
      };
    }),
    unknownTasks: named.flatMap((c) =>
      c.tasks.filter((t) => !known.has(t)).map((taskId) => ({ changeId: c.id, taskId })),
    ),
    unphased: named.filter((c) => c.phase === null).map((c) => c.id),
    linked: named.some((c) => c.tasks.length > 0),
  };
}

// Rounds are snapshots, so comparing two never gives a different answer: keep recent ones.
const comparisons = new Map<string, Promise<SinceView>>();
const KEEP_COMPARISONS = 32;

/** What changed in round `n` since round `from`, change by change, like `lr diff`. */
export function sinceView(ctx: Context, slug: string, n: string, from: string): Promise<SinceView> {
  const feature = getFeature(ctx, slug);
  const to = ctx.round(feature, n === "latest" ? undefined : n);
  const earlier = ctx.round(feature, from);
  if (earlier.n >= to.n) throw new LrError(`round ${earlier.n} isn't earlier than round ${to.n}`);

  // Op ids too, in case a purged feature's slug was reused.
  const key = [ctx.jj.root, slug, earlier.n, earlier.jjOpId, to.n, to.jjOpId].join("\0");
  let view = comparisons.get(key);
  if (!view) {
    view = compareRounds(ctx, earlier, to);
    view.catch(() => comparisons.delete(key));
    comparisons.set(key, view);
    if (comparisons.size > KEEP_COMPARISONS) {
      comparisons.delete(comparisons.keys().next().value!);
    }
  }
  return view;
}

async function compareRounds(ctx: Context, from: Round, to: Round): Promise<SinceView> {
  const changes = await compare(ctx.jj, from, to);
  return {
    from: from.n,
    to: to.n,
    baseMoved:
      from.baseCommitId === to.baseCommitId
        ? null
        : { from: from.baseCommitId, to: to.baseCommitId },
    changes: changes.map(({ patch, files: _, ...c }) => {
      const { message, files } = splitMessage(patch);
      const interdiff = c.status === "changed" && c.note === null;
      return { ...c, files: interdiff ? files : [], message };
    }),
  };
}

/**
 * `jj interdiff --git` shows a message edit as a file named `JJ-COMMIT-DESCRIPTION`, whose `---`
 * line has no `a/` (a real file's always does). Take it out of the files.
 */
function splitMessage(patch: string): { message: FileDiff | null; files: FileDiff[] } {
  const sections = patch.split(/^(?=diff --git )/m);
  const isMessage = (s: string) => s.split("\n", 3)[1] === "--- JJ-COMMIT-DESCRIPTION";
  const message = sections.find(isMessage);
  return {
    message: message ? parsePatch(message)[0]! : null,
    files: parsePatch(sections.filter((s) => !isMessage(s)).join("")),
  };
}

// ── Writes, all as `ctx.actor` ────────────────────────────────────────────────

/** `POST …/draft/comments`: check where a comment goes, then add it to the actor's draft. */
export async function addDraftComment(
  ctx: Context,
  slug: string,
  n: string,
  input: DraftCommentInput,
): Promise<ReviewDraft> {
  const { feature, round, draft } = openDraft(ctx, slug, n);
  draft.comments.push({ id: Bun.randomUUIDv7(), ...(await checked(ctx, feature, round, input)) });
  ctx.store.saveDraft(slug, round.n, ctx.actor, draft);
  return draft;
}

/** `PUT …/draft/comments/:id` */
export async function updateDraftComment(
  ctx: Context,
  slug: string,
  n: string,
  id: string,
  input: DraftCommentInput,
): Promise<ReviewDraft> {
  const { feature, round, draft } = openDraft(ctx, slug, n);
  const i = draftIndex(draft, id);
  draft.comments[i] = { id, ...(await checked(ctx, feature, round, input)) };
  ctx.store.saveDraft(slug, round.n, ctx.actor, draft);
  return draft;
}

/** `DELETE …/draft/comments/:id` */
export function deleteDraftComment(ctx: Context, slug: string, n: string, id: string): ReviewDraft {
  const { round, draft } = openDraft(ctx, slug, n);
  draft.comments.splice(draftIndex(draft, id), 1);
  ctx.store.saveDraft(slug, round.n, ctx.actor, draft);
  return draft;
}

/** `PUT …/draft`: the verdict and summary, saved as they're written. */
export function saveDraftSummary(
  ctx: Context,
  slug: string,
  n: string,
  summary: { verdict: Verdict | null; body: string | null },
): ReviewDraft {
  const { round, draft } = openDraft(ctx, slug, n);
  const saved = { ...draft, verdict: summary.verdict ?? null, body: summary.body || null };
  ctx.store.saveDraft(slug, round.n, ctx.actor, saved);
  return saved;
}

/** `DELETE …/draft`: throw the draft away. Works on any round, e.g. one superseded meanwhile. */
export function discardDraft(ctx: Context, slug: string, n: string): { ok: true } {
  const round = ctx.round(getFeature(ctx, slug), n);
  ctx.store.deleteDraft(slug, round.n, ctx.actor);
  return { ok: true };
}

/** `POST …/draft/submit`: record the draft as a review, exactly as `lr review submit` would. */
export async function submitDraft(
  ctx: Context,
  slug: string,
  n: string,
  summary: { verdict: Verdict | null; body: string | null },
): Promise<ReviewSubmitOk> {
  const { feature, round, draft } = openDraft(ctx, slug, n);
  const data: Record<string, unknown> = { comments: draft.comments.map((c) => c.comment) };
  if (summary.verdict) data.verdict = summary.verdict;
  if (summary.body?.trim()) data.body = summary.body;
  const ok = await recordReview(ctx, feature, round, data);
  ctx.store.deleteDraft(slug, round.n, ctx.actor);
  return ok;
}

/** `POST /api/features/:slug/threads/:id/replies`, like `lr reply`. */
export function replyToThread(
  ctx: Context,
  slug: string,
  id: string,
  opts: { action?: ReplyAction | null; body?: string | null },
): ReplyOk {
  const feature = getFeature(ctx, slug);
  if (!/^\d+$/.test(id)) throw new LrError(`no thread #${id} in ${slug}`);
  return {
    thread: applyReply(ctx, feature, Number(id), {
      action: opts.action ?? null,
      body: opts.body ?? null,
    }),
  };
}

/** The feature, its round (which must be open for review), and the actor's draft of it. */
function openDraft(ctx: Context, slug: string, n: string) {
  const feature = getFeature(ctx, slug);
  const round = pickRound(ctx, feature, n);
  const draft = ctx.store.getDraft<ReviewDraft>(slug, round.n, ctx.actor) ?? {
    round: round.n,
    verdict: null,
    body: null,
    comments: [],
  };
  return { feature, round, draft };
}

function draftIndex(draft: ReviewDraft, id: string): number {
  const i = draft.comments.findIndex((c) => c.id === id);
  if (i < 0) throw new LrError(`no draft comment ${id}`);
  return i;
}

/** The comment, checked the way `lr review submit` checks it, and where it shows. */
async function checked(
  ctx: Context,
  feature: Feature,
  round: Round,
  input: DraftCommentInput,
): Promise<Omit<DraftComment, "id">> {
  // Drop empty fields, so the stored comment is exactly what a review file would say.
  const comment = Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== null && v !== undefined && v !== false),
  ) as DraftCommentInput;
  const anchor = await resolveComment(ctx, feature, round, comment);
  return { comment, placement: place({ anchor, anchorState: "current" }, round) };
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
