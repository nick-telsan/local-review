import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { CheckConfig, RepoConfig } from "./config.ts";

export type CheckSettings = Pick<RepoConfig, "setup" | "checks">;

import { LrError } from "./errors.ts";
import { Jj } from "./jj.ts";
import type { ChangeSnapshot, CheckRun, Phase } from "./model.ts";
import type { Store } from "./store.ts";

export interface CheckTarget {
  check: CheckConfig;
  change: ChangeSnapshot;
}

export interface CheckResult {
  run: CheckRun;
  /** Reused a passing run of the same command at the same commit. */
  cached: boolean;
}

/** Expand each check's `at` into concrete (check, change) pairs, in stack order. */
export function checkTargets(
  checks: CheckConfig[],
  changes: ChangeSnapshot[],
  phases: Phase[],
): CheckTarget[] {
  const phaseBookmarks = new Set(phases.map((p) => p.bookmark));
  const tip = changes.at(-1);
  const targets: CheckTarget[] = [];
  for (const change of changes) {
    for (const check of checks) {
      const wanted =
        check.at === "tip"
          ? change === tip
          : check.at === "bookmarks"
            ? change.bookmarks.some((b) => phaseBookmarks.has(b))
            : !change.empty;
      if (wanted) targets.push({ check, change });
    }
  }
  return targets;
}

/**
 * Run checks in a dedicated jj workspace (`<feature dir>/workspaces/checks`), so the developer's
 * working copy is never touched. Passing results are reused when the commit and command match.
 */
export async function runChecks(opts: {
  jj: Jj;
  store: Store;
  slug: string;
  featureDir: string;
  config: CheckSettings;
  targets: CheckTarget[];
  trigger: CheckRun["trigger"];
  log: (line: string) => void;
}): Promise<CheckResult[]> {
  const { store, slug, featureDir, targets, log } = opts;
  const logDir = join(featureDir, "checks");
  mkdirSync(logDir, { recursive: true });

  const results: CheckResult[] = [];
  const toRun: CheckTarget[] = [];
  for (const t of targets) {
    const cached = store.findPassingCheck(slug, t.check.name, t.check.run, t.change.commitId);
    if (cached) results.push({ run: cached, cached: true });
    else toRun.push(t);
  }
  if (toRun.length === 0) return results;

  // Group by commit so each commit is checked out (and set up) once.
  const byCommit = new Map<string, CheckTarget[]>();
  for (const t of toRun)
    byCommit.set(t.change.commitId, [...(byCommit.get(t.change.commitId) ?? []), t]);

  const ws = await CheckWorkspace.open(opts.jj, slug, join(featureDir, "workspaces", "checks"));
  try {
    for (const [commitId, group] of byCommit) {
      const change = group[0]!.change;
      log(`checking out ${change.changeId.slice(0, 8)} (${commitId.slice(0, 8)})`);
      await ws.checkout(commitId);

      let setupFailed: { logPath: string } | null = null;
      if (opts.config.setup) {
        const setupLog = join(logDir, `setup-${commitId.slice(0, 12)}-${Bun.randomUUIDv7()}.log`);
        const res = await execLogged(opts.config.setup, ws.dir, setupLog, 10 * 60_000, {});
        if (res.status !== "pass") {
          log(`  setup failed: ${setupLog}`);
          setupFailed = { logPath: setupLog };
        }
      }

      for (const { check } of group) {
        const id = Bun.randomUUIDv7();
        const logPath = setupFailed?.logPath ?? join(logDir, `${id}.log`);
        const run: CheckRun = {
          id,
          check: check.name,
          command: check.run,
          changeId: change.changeId,
          commitId,
          trigger: opts.trigger,
          status: "running",
          exitCode: null,
          logPath,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        };
        store.insertCheckRun(slug, run);

        if (setupFailed) {
          run.status = "error";
        } else {
          log(`  ${check.name}: ${check.run}`);
          const res = await execLogged(check.run, ws.dir, logPath, check.timeoutMs, {
            LR_CHECK: check.name,
            LR_CHANGE_ID: change.changeId,
            LR_COMMIT_ID: commitId,
          });
          run.status = res.status;
          run.exitCode = res.exitCode;
        }
        run.finishedAt = new Date().toISOString();
        store.updateCheckRun(id, {
          status: run.status,
          exitCode: run.exitCode,
          finishedAt: run.finishedAt,
        });
        log(`  ${check.name}: ${run.status}`);
        results.push({ run, cached: false });
      }
    }
  } finally {
    await ws.clean();
  }
  return results;
}

async function execLogged(
  command: string,
  cwd: string,
  logPath: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<{ status: "pass" | "fail" | "error"; exitCode: number | null }> {
  const fd = openSync(logPath, "w");
  try {
    writeSync(fd, `$ ${command}\n`);
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const exitCode = await proc.exited;
    if (proc.signalCode) {
      writeSync(fd, `\n[lr] killed by ${proc.signalCode} (timeout ${timeoutMs}ms)\n`);
      return { status: "error", exitCode: null };
    }
    return { status: exitCode === 0 ? "pass" : "fail", exitCode };
  } catch (e) {
    writeSync(fd, `\n[lr] failed to start: ${(e as Error).message}\n`);
    return { status: "error", exitCode: null };
  } finally {
    closeSync(fd);
  }
}

/** A jj workspace owned by local-review, used only to run checks. */
class CheckWorkspace {
  private constructor(
    readonly dir: string,
    private readonly ws: Jj,
  ) {}

  static async open(repo: Jj, slug: string, dir: string): Promise<CheckWorkspace> {
    const name = `lr-${slug}-checks`;
    if (!existsSync(join(dir, ".jj"))) {
      // Created at the root commit; `checkout` moves it where it's needed.
      mkdirSync(join(dir, ".."), { recursive: true });
      try {
        await repo.run(["workspace", "add", "--name", name, "-r", "root()", dir]);
      } catch (e) {
        // The directory was deleted but jj still remembers the workspace.
        if (!(e instanceof LrError) || !e.message.includes("already exists")) throw e;
        await repo.run(["workspace", "forget", name]);
        await repo.run(["workspace", "add", "--name", name, "-r", "root()", dir]);
      }
    }
    return new CheckWorkspace(dir, new Jj(dir));
  }

  async checkout(commitId: string): Promise<void> {
    // The main workspace may have rewritten commits since we last ran.
    await this.ws.run(["workspace", "update-stale"]);
    await this.clean();
    await this.ws.run(["new", commitId]);
  }

  /** Discard anything a check wrote, so the workspace commit stays empty and jj abandons it. */
  async clean(): Promise<void> {
    await this.ws.run(["restore"]);
  }
}
