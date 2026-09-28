import { findChange } from "../anchors.ts";
import { type CheckTarget, checkTargets, runChecks } from "../checks.ts";
import { loadRepoConfig } from "../config.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import type { ChangeSnapshot } from "../model.ts";
import { takeSnapshot } from "../snapshot.ts";
import { type CheckResultJson, checkJson, progress } from "./review.ts";

/** `lr check --json` output. */
export interface CheckOk {
  /** The round whose commits were checked, or null for the stack as it is now. */
  round: number | null;
  checks: CheckResultJson[];
}

/**
 * Run checks by hand: on the stack as it is now (e.g. before opening a round), or with `--round`
 * on a round's commits (e.g. a reviewer rerunning a flaky check), which adds the runs to that
 * round. Named changes get every check, whatever its `at`. Passing runs at the same commit are
 * reused unless `--rerun`. Exits 1 if any check doesn't pass.
 */
export async function check(
  ctx: Context,
  changeArgs: string[],
  opts: { check?: string; round?: string; rerun?: boolean },
): Promise<number> {
  const feature = ctx.feature();
  const config = await loadRepoConfig(ctx.jj.root);
  if (config.checks.length === 0) {
    throw new LrError("no checks configured (add [[checks]] to .local-review.toml)");
  }

  let checks = config.checks;
  if (opts.check !== undefined) {
    const names = opts.check.split(",").map((n) => n.trim());
    const unknown = names.filter((n) => !checks.some((c) => c.name === n));
    if (unknown.length) {
      throw new LrError(
        `no check named ${unknown.join(", ")} (checks: ${checks.map((c) => c.name).join(", ")})`,
      );
    }
    checks = checks.filter((c) => names.includes(c.name));
  }

  let changes: ChangeSnapshot[];
  let where: string;
  let round: number | null = null;
  const plan = ctx.currentPlan(feature);
  let phases = plan.phases;
  if (opts.round !== undefined) {
    const r = ctx.round(feature, opts.round);
    ({ changes, n: round } = r);
    phases = ctx.store.getPlanVersion(feature.slug, r.planVersion)!.phases;
    where = `round ${r.n}`;
  } else {
    if (feature.status === "done" || feature.status === "abandoned") {
      throw new LrError(
        `feature "${feature.slug}" is ${feature.status}; check a round's commits with --round`,
      );
    }
    const snap = await takeSnapshot(ctx.jj, feature.baseRevset, phases, { beforeBookmarks: true });
    for (const w of snap.warnings) progress(ctx, `warning: ${w}`);
    changes = snap.changes;
    where = "the stack";
  }

  const targets: CheckTarget[] = changeArgs.length
    ? [...new Set(changeArgs.map((arg) => findChange(changes, arg, where)))].flatMap((change) =>
        checks.map((c) => ({ check: c, change })),
      )
    : checkTargets(checks, changes, phases);
  if (targets.length === 0) {
    throw new LrError(`none of these checks apply to ${where} (see each check's \`at\`)`);
  }

  const results = await runChecks({
    jj: ctx.jj,
    store: ctx.store,
    slug: feature.slug,
    featureDir: ctx.featureDir(feature.slug),
    config: { ...config, checks },
    targets,
    trigger: "manual",
    log: (line) => progress(ctx, line),
    rerun: opts.rerun,
  });
  if (round !== null) {
    ctx.store.linkRoundChecks(
      feature.slug,
      round,
      results.map((r) => r.run.id),
    );
  }

  const failed = results.filter((r) => r.run.status !== "pass");
  const cached = results.filter((r) => r.cached).length;
  const json: CheckOk = { round, checks: results.map(checkJson) };
  ctx.print(json, [
    `Checks on ${where}: ${results.length - failed.length}/${results.length} passed` +
      (cached ? ` (${cached} cached; --rerun runs them again)` : ""),
    ...results.map(
      (r) =>
        `  ${r.run.status.padEnd(6)} ${r.run.check} @ ${r.run.changeId.slice(0, 8)}` +
        (r.run.status === "pass" ? "" : `  log: ${r.run.logPath}`),
    ),
  ]);
  return failed.length ? 1 : 0;
}
