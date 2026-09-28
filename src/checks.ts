import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type CheckConfig, formatDuration, type RepoConfig } from "./config.ts";

export type CheckSettings = Pick<RepoConfig, "setup" | "setupKillAfterMs" | "checks">;

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

  const ws = await CheckWorkspace.open(opts.jj, slug, checkWorkspaceDir(featureDir));
  try {
    for (const [commitId, group] of byCommit) {
      const change = group[0]!.change;
      log(`checking out ${change.changeId.slice(0, 8)} (${commitId.slice(0, 8)})`);
      await ws.checkout(commitId);

      let setupFailed: { logPath: string } | null = null;
      if (opts.config.setup) {
        const setupLog = join(logDir, `setup-${commitId.slice(0, 12)}-${Bun.randomUUIDv7()}.log`);
        const res = await execLogged(opts.config.setup, ws.dir, setupLog, {
          name: "setup",
          timeoutMs: 10 * 60_000,
          killAfterMs: opts.config.setupKillAfterMs,
          env: {},
          log,
        });
        if (res.interrupted) throw interruptedError(res.interrupted);
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
        let interrupted: Forwarded | null = null;

        if (setupFailed) {
          run.status = "error";
        } else {
          log(`  ${check.name}: ${check.run}`);
          const res = await execLogged(check.run, ws.dir, logPath, {
            name: check.name,
            timeoutMs: check.timeoutMs,
            killAfterMs: check.killAfterMs,
            env: { LR_CHECK: check.name, LR_CHANGE_ID: change.changeId, LR_COMMIT_ID: commitId },
            log,
          });
          run.status = res.status;
          run.exitCode = res.exitCode;
          interrupted = res.interrupted;
        }
        run.finishedAt = new Date().toISOString();
        store.updateCheckRun(id, {
          status: run.status,
          exitCode: run.exitCode,
          finishedAt: run.finishedAt,
        });
        if (interrupted) throw interruptedError(interrupted);
        log(`  ${check.name}: ${run.status}`);
        results.push({ run, cached: false });
      }
    }
  } finally {
    await ws.clean();
  }
  return results;
}

/** Stop the round: the developer asked lr to stop, so it exits the way an interrupted shell does. */
function interruptedError(signal: Forwarded): LrError {
  return new LrError(`checks interrupted by ${signal}`, 128 + SIGNAL_NUMBER[signal]);
}

/** Signals lr passes on to a running check, since the check runs in its own process group. */
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type Forwarded = (typeof FORWARDED)[number];
const SIGNAL_NUMBER: Record<Forwarded, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

interface ExecResult {
  status: "pass" | "fail" | "error";
  exitCode: number | null;
  /** lr received this signal while the command ran. */
  interrupted: Forwarded | null;
}

/**
 * Run `command` in its own process group, so a timeout stops everything it started, not just the
 * shell. Whatever it leaves running is stopped too, before lr touches the workspace again.
 */
async function execLogged(
  command: string,
  cwd: string,
  logPath: string,
  opts: {
    name: string;
    timeoutMs: number;
    killAfterMs: number;
    env: Record<string, string>;
    log: (line: string) => void;
  },
): Promise<ExecResult> {
  const { name, timeoutMs, killAfterMs, log } = opts;
  const fd = openSync(logPath, "w");
  try {
    writeSync(fd, `$ ${command}\n`);
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        env: { ...process.env, ...opts.env },
        detached: true,
      });
    } catch (e) {
      writeSync(fd, `\n[lr] failed to start: ${(e as Error).message}\n`);
      return { status: "error", exitCode: null, interrupted: null };
    }
    const group = new ProcessGroup(proc.pid, killAfterMs);
    const waiting = (what: string) => () =>
      log(
        `  ${name}: ${what}; waiting up to ${formatDuration(killAfterMs)} for it to stop ` +
          "(Ctrl-C to kill it now)",
      );

    let timedOut: Promise<StopSignal | null> | null = null;
    const timer = setTimeout(() => {
      timedOut = group.stop(waiting(`timed out after ${formatDuration(timeoutMs)}`));
    }, timeoutMs);
    // The check isn't in the terminal's process group, so Ctrl-C reaches lr alone: pass it on.
    // A second one, or one while lr is already stopping the check, kills.
    let interrupted: Forwarded | null = null;
    const onSignal = (signal: Forwarded) => {
      group.kill(interrupted || group.stopping ? "SIGKILL" : signal);
      interrupted ??= signal;
    };
    for (const signal of FORWARDED) process.on(signal, onSignal);

    try {
      const exitCode = await proc.exited;
      clearTimeout(timer);
      const stoppedBy = await (timedOut ?? group.stop(waiting("stopping what it left running")));
      if (interrupted) {
        writeSync(fd, `\n[lr] interrupted by ${interrupted}\n`);
        return { status: "error", exitCode: null, interrupted };
      }
      if (timedOut) {
        writeSync(
          fd,
          `\n[lr] timed out after ${formatDuration(timeoutMs)}; stopped with ${stoppedBy}\n`,
        );
        return { status: "error", exitCode: null, interrupted: null };
      }
      if (stoppedBy) writeSync(fd, `\n[lr] stopped processes it left running (${stoppedBy})\n`);
      return { status: exitCode === 0 ? "pass" : "fail", exitCode, interrupted: null };
    } finally {
      clearTimeout(timer);
      for (const signal of FORWARDED) process.off(signal, onSignal);
    }
  } finally {
    closeSync(fd);
  }
}

type StopSignal = "SIGTERM" | "SIGKILL";

/** How long a stopped check can take to exit before lr says it's waiting. */
const QUICK_EXIT_MS = 500;

/** A process group led by a check's shell: the check and everything it started. */
class ProcessGroup {
  /** lr has sent SIGTERM and is waiting for the group to exit. */
  stopping = false;

  constructor(
    private readonly pgid: number,
    private readonly killAfterMs: number,
  ) {}

  /** False once there's nothing left to signal. */
  kill(signal: NodeJS.Signals | 0): boolean {
    try {
      process.kill(-this.pgid, signal);
      return true;
    } catch (e) {
      // ESRCH: the group is empty. EPERM: macOS, when only zombies are left.
      if (["ESRCH", "EPERM"].includes((e as NodeJS.ErrnoException).code!)) return false;
      throw e;
    }
  }

  alive(): boolean {
    return this.kill(0);
  }

  /**
   * SIGTERM, then SIGKILL if it outlasts `killAfterMs`. Null if nothing was running. `onWait` is
   * called if it doesn't exit right away.
   */
  async stop(onWait: () => void): Promise<StopSignal | null> {
    if (!this.alive()) return null;
    this.stopping = true;
    this.kill("SIGTERM");
    const beat = Math.min(QUICK_EXIT_MS, this.killAfterMs);
    if (await this.gone(beat)) return "SIGTERM";
    onWait();
    if (await this.gone(this.killAfterMs - beat)) return "SIGTERM";
    this.kill("SIGKILL");
    await this.gone(5000);
    return "SIGKILL";
  }

  private async gone(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (this.alive()) {
      if (Date.now() >= until) return false;
      await Bun.sleep(20);
    }
    return true;
  }
}

/** The jj workspace a feature's checks run in. */
export function checkWorkspaceName(slug: string): string {
  return `lr-${slug}-checks`;
}

/** Where that workspace lives, under the feature's directory. */
export function checkWorkspaceDir(featureDir: string): string {
  return join(featureDir, "workspaces", "checks");
}

/** A jj workspace owned by local-review, used only to run checks. */
class CheckWorkspace {
  private constructor(
    readonly dir: string,
    private readonly ws: Jj,
  ) {}

  static async open(repo: Jj, slug: string, dir: string): Promise<CheckWorkspace> {
    const name = checkWorkspaceName(slug);
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
