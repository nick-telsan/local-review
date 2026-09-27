import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type CheckResult, checkTargets, runChecks } from "../checks.ts";
import { loadRepoConfig } from "../config.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import type { ChangeSnapshot, CheckRun, Phase, Round, RoundStatus } from "../model.ts";
import { type ReanchoredThread, reanchorThreads } from "../reanchor.ts";
import { takeSnapshot } from "../snapshot.ts";

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
  warnings: string[];
}

/** `lr review create --json` output when checks or conflicts blocked the round. */
export interface ReviewCreateBlocked {
  ok: false;
  conflicted: string[];
  checks: CheckResultJson[];
  warnings: string[];
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
  const config = await loadRepoConfig(ctx.jj.root);
  const progress = (line: string) => {
    if (!ctx.json) ctx.io.err(line);
  };

  const snap = await takeSnapshot(ctx.jj, feature.baseRevset, plan.phases);
  for (const w of snap.warnings) progress(`warning: ${w}`);

  let results: CheckResult[] = [];
  if (opts.skipChecks) {
    progress("skipping checks (--skip-checks)");
  } else if (config.checks.length === 0) {
    progress("no checks configured (add [[checks]] to .local-review.toml)");
  } else {
    const targets = checkTargets(config.checks, snap.changes, plan.phases);
    results = await runChecks({
      jj: ctx.jj,
      store: ctx.store,
      slug: feature.slug,
      featureDir: ctx.featureDir(feature.slug),
      config,
      targets,
      trigger: "auto",
      log: progress,
    });
  }

  const conflicted = snap.changes.filter((c) => c.conflicted);
  const failed = results.filter((r) => r.run.status !== "pass");
  const checksJson: CheckResultJson[] = results.map((r) => ({ ...r.run, cached: r.cached }));

  if ((failed.length > 0 || conflicted.length > 0) && !opts.allowFailing) {
    ctx.print(
      {
        ok: false,
        conflicted: conflicted.map((c) => c.changeId),
        checks: checksJson,
        warnings: snap.warnings,
      } satisfies ReviewCreateBlocked,
      [
        "No round opened: fix these and run `lr review create` again.",
        ...conflicted.map((c) => `  conflicted: ${label(c)}`),
        ...failed.map(
          (r) =>
            `  ${r.run.status}: ${r.run.check} @ ${r.run.changeId.slice(0, 8)}  log: ${r.run.logPath}`,
        ),
      ],
    );
    return 1;
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
    warnings: snap.warnings,
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
  ]);
  return 0;
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
