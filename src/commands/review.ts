import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type CheckResult, checkTargets, runChecks } from "../checks.ts";
import { loadRepoConfig } from "../config.ts";
import type { Context } from "../context.ts";
import { describeGap, type PlanGap, planGaps } from "../coverage.ts";
import { LrError } from "../errors.ts";
import type { ChangeSnapshot, CheckRun, Phase, Round, RoundStatus } from "../model.ts";
import { type ReanchoredThread, reanchorThreads } from "../reanchor.ts";
import { takeSnapshot } from "../snapshot.ts";
import { roundPath, uiLink } from "../ui/running.ts";

export type CheckResultJson = CheckRun & { cached: boolean };

/** `lr review create --json` output when a round was opened. */
export interface ReviewCreateOk {
  ok: true;
  round: Round;
  /** The round this one replaced: `closed` if it had been reviewed, else `superseded`. */
  replaced: { n: number; status: RoundStatus } | null;
  checks: CheckResultJson[];
  /** Unsettled threads from earlier rounds, carried onto this one. */
  reanchored: ReanchoredThread[];
  /** Includes each plan gap, described. */
  warnings: string[];
  /** Where the stack and the plan's tasks don't line up (see `planGaps`). */
  planGaps: PlanGap[];
  /** The round's page in the review UI, when `lr ui` is running for this repo (no token). */
  uiUrl: string | null;
}

/** `lr review create --json` output when checks or conflicts blocked the round. */
export interface ReviewCreateBlocked {
  ok: false;
  conflicted: string[];
  checks: CheckResultJson[];
  warnings: string[];
  planGaps: PlanGap[];
}

/**
 * Snapshot the stack, run checks, and open a new review round. If a check fails or a change is
 * conflicted, no round is opened (unless --allow-failing) and the exit code is 1, so the agent
 * that ran it knows to fix things and try again.
 */
export async function reviewCreate(
  ctx: Context,
  opts: { allowFailing?: boolean; skipChecks?: boolean },
): Promise<number> {
  const feature = ctx.feature();
  if (feature.status === "done" || feature.status === "abandoned") {
    throw new LrError(`feature "${feature.slug}" is ${feature.status}`);
  }
  const plan = ctx.currentPlan(feature);
  const snap = await takeSnapshot(ctx.jj, feature.baseRevset, plan.phases);
  // Gaps between the plan's tasks and the changes' Plan-Task trailers warn; they don't block.
  const gaps = planGaps(snap, plan.phases);
  const warnings = [
    ...snap.warnings,
    ...gaps.map((g) => `plan gap: ${describeGap(g, snap.changes)}`),
  ];
  for (const w of warnings) progress(ctx, `warning: ${w}`);

  let results: CheckResult[] = [];
  if (opts.skipChecks) progress(ctx, "skipping checks (--skip-checks)");
  else results = await checkStack(ctx, feature.slug, snap.changes, plan.phases);

  const conflicted = snap.changes.filter((c) => c.conflicted);
  const failed = results.filter((r) => r.run.status !== "pass");
  const checksJson = results.map(checkJson);

  if ((failed.length > 0 || conflicted.length > 0) && !opts.allowFailing) {
    return printBlocked(ctx, {
      heading: "No round opened: fix these and run `lr review create` again.",
      conflicted,
      results,
      warnings,
      planGaps: gaps,
    });
  }

  // Read patches at the pinned operation before committing anything to the store.
  const pinned = ctx.jj.at(snap.jjOpId);
  const patches = await Promise.all(snap.changes.map((c) => pinned.diffGit(c.commitId)));

  const { round, replaced } = ctx.store.createRound(feature.slug, {
    jjOpId: snap.jjOpId,
    planVersion: plan.version,
    baseCommitId: snap.baseCommitId,
    changes: snap.changes,
    checkRunIds: results.map((r) => r.run.id),
    createdBy: ctx.actor,
  });

  const reanchored = await reanchorThreads({
    jj: ctx.jj,
    store: ctx.store,
    slug: feature.slug,
    round,
    phases: plan.phases,
    plan: { version: plan.version, text: await ctx.planText(feature.slug, plan) },
  });

  const patchDir = join(ctx.featureDir(feature.slug), "rounds", String(round.n), "patches");
  mkdirSync(patchDir, { recursive: true });
  await Promise.all(
    snap.changes.map((c, i) => Bun.write(join(patchDir, `${c.changeId}.patch`), patches[i]!)),
  );

  const passed = results.filter((r) => r.run.status === "pass");
  const cached = results.filter((r) => r.cached).length;
  const json: ReviewCreateOk = {
    ok: true,
    round,
    replaced,
    checks: checksJson,
    reanchored,
    warnings,
    planGaps: gaps,
    uiUrl: uiLink(ctx.jj.root, roundPath(feature.slug, round.n)),
  };
  ctx.print(json, [
    `Round ${round.n} opened for ${feature.slug} (plan v${plan.version}, base ${snap.baseCommitId.slice(0, 8)})`,
    ...(replaced ? [`  round ${replaced.n} is now ${replaced.status}`] : []),
    ...describeStack(snap.changes, plan.phases),
    results.length === 0
      ? "Checks: none run"
      : `Checks: ${passed.length}/${results.length} passed${cached ? ` (${cached} cached)` : ""}` +
        (failed.length ? ` — ${failed.length} failing (--allow-failing)` : ""),
    ...(reanchored.length ? [`Threads: ${describeReanchored(reanchored)}`] : []),
    ...(gaps.length
      ? [
          `Plan gaps: ${gaps.length} (the warnings above; \`lr status\` lists them too). Implement ` +
            "the task, add a `Plan-Task: <id>` trailer, or drop it in a revised plan.",
        ]
      : []),
    ...(json.uiUrl ? [`Review it in the browser: ${json.uiUrl}`] : []),
  ]);
  return 0;
}

export const checkJson = (r: CheckResult): CheckResultJson => ({ ...r.run, cached: r.cached });

/** A progress line on stderr, unless the output is JSON. */
export function progress(ctx: Context, line: string): void {
  if (!ctx.json) ctx.io.err(line);
}

/** Run the repo's checks on a stack, reusing passing runs of the same command at the same commit. */
export async function checkStack(
  ctx: Context,
  slug: string,
  changes: ChangeSnapshot[],
  phases: Phase[],
): Promise<CheckResult[]> {
  const config = await loadRepoConfig(ctx.jj.root);
  if (config.checks.length === 0) {
    progress(ctx, "no checks configured (add [[checks]] to .local-review.toml)");
    return [];
  }
  return runChecks({
    jj: ctx.jj,
    store: ctx.store,
    slug,
    featureDir: ctx.featureDir(slug),
    config,
    targets: checkTargets(config.checks, changes, phases),
    trigger: "auto",
    log: (line) => progress(ctx, line),
  });
}

/** Report a round that conflicts or failing checks kept from opening. Returns the exit code, 1. */
export function printBlocked(
  ctx: Context,
  b: {
    heading: string;
    conflicted: ChangeSnapshot[];
    results: CheckResult[];
    warnings: string[];
    planGaps?: PlanGap[];
  },
): number {
  const failed = b.results.filter((r) => r.run.status !== "pass");
  ctx.print(
    {
      ok: false,
      conflicted: b.conflicted.map((c) => c.changeId),
      checks: b.results.map(checkJson),
      warnings: b.warnings,
      planGaps: b.planGaps ?? [],
    } satisfies ReviewCreateBlocked,
    [
      b.heading,
      ...b.conflicted.map((c) => `  conflicted: ${label(c)}`),
      ...failed.map(
        (r) =>
          `  ${r.run.status}: ${r.run.check} @ ${r.run.changeId.slice(0, 8)}  log: ${r.run.logPath}`,
      ),
    ],
  );
  return 1;
}

/** e.g. `2 current, 1 moved (#3), 1 outdated (#5)`. */
export function describeReanchored(threads: ReanchoredThread[]): string {
  const states = ["current", "moved", "outdated"] as const;
  return states
    .map((state) => {
      const ids = threads.filter((t) => t.anchorState === state).map((t) => `#${t.id}`);
      if (ids.length === 0) return null;
      return state === "current"
        ? `${ids.length} current`
        : `${ids.length} ${state} (${ids.join(", ")})`;
    })
    .filter(Boolean)
    .join(", ");
}

export function describeStack(changes: ChangeSnapshot[], phases: Phase[]): string[] {
  const lines: string[] = [];
  const groups: { phase: Phase | null; changes: ChangeSnapshot[] }[] = [];
  for (const c of changes) {
    const last = groups.at(-1);
    if (last && (last.phase?.id ?? null) === c.phaseId) last.changes.push(c);
    else groups.push({ phase: phases.find((p) => p.id === c.phaseId) ?? null, changes: [c] });
  }
  for (const g of groups) {
    lines.push(
      g.phase ? `Phase ${g.phase.id}: ${g.phase.title} [${g.phase.bookmark}]` : "Unassigned:",
    );
    for (const c of g.changes) lines.push(`  ${label(c)}`);
  }
  return lines;
}

function label(c: ChangeSnapshot): string {
  const subject = c.description.split("\n")[0] || "(no description)";
  const flags = [c.conflicted && "conflicted", c.empty && "empty"].filter(Boolean).join(", ");
  return (
    `${c.changeId.slice(0, 8)} ${c.commitId.slice(0, 8)}  ${subject}  ` +
    `(+${c.stats.added} -${c.stats.removed}, ${c.stats.files} files)${flags ? ` [${flags}]` : ""}`
  );
}
