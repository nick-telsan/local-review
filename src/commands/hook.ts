import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, type Io } from "../context.ts";
import { LrError } from "../errors.ts";
import { Jj } from "../jj.ts";
import type { Feature } from "../model.ts";
import { repoDir } from "../paths.ts";
import { takeSnapshot } from "../snapshot.ts";
import { roundPath, uiLink } from "../ui/running.ts";
import { nextStep } from "./status.ts";

export const HOOK_EVENTS = ["session-start", "pre-tool-use", "stop"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

/** The fields lr reads from the JSON Claude Code sends a hook on stdin. */
interface HookInput {
  cwd?: string;
  session_id?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: { command?: string };
}

const SKILLS =
  "Use the lr-author skill to plan, implement, or revise, and the lr-review skill to review a round.";

/**
 * `lr hook <event>`: Claude Code hook handlers. Each reads the hook's JSON from stdin and stays
 * silent (exit 0) unless lr is in use in the session's repo.
 */
export async function hook(event: string | undefined, io: Io, repo?: string): Promise<number> {
  if (!HOOK_EVENTS.includes(event as HookEvent)) {
    throw new LrError(`usage: lr hook ${HOOK_EVENTS.join("|")} (reads the hook's JSON on stdin)`);
  }
  const input = JSON.parse((await io.stdin()) || "{}") as HookInput;
  if (event === "pre-tool-use") return preToolUse(input, io);

  const ctx = await openContext(input.cwd ?? repo ?? process.cwd(), io);
  if (!ctx) return 0;
  try {
    return event === "session-start" ? await sessionStart(ctx, input) : await stop(ctx, input);
  } finally {
    ctx.close();
  }
}

/** A context for the repo at `cwd`, or null if it isn't a jj repo lr has been used in. */
async function openContext(cwd: string, io: Io): Promise<Context | null> {
  let root: string;
  try {
    root = (await Jj.discover(cwd)).root;
  } catch (e) {
    if (e instanceof LrError) return null;
    throw e;
  }
  // Checked first because opening the store would create lr's state for this repo.
  if (!existsSync(join(repoDir(root), "state.db"))) return null;
  return Context.create({ repo: root }, io);
}

/** The feature lr commands would act on, or null when there's none (or no single one). */
function currentFeature(ctx: Context): Feature | null {
  try {
    return ctx.feature();
  } catch (e) {
    if (e instanceof LrError) return null;
    throw e;
  }
}

/**
 * Tell the session which feature lr is tracking and what it's waiting on, and remember the stack
 * as the session found it (see `stop`).
 */
async function sessionStart(ctx: Context, input: HookInput): Promise<number> {
  const feature = currentFeature(ctx);
  const session = readSession(ctx, input);
  // Resuming or compacting keeps the session id, and the stack it started with.
  if (session.start === undefined) {
    const start = feature?.currentPlanVersion ? await stackKey(ctx, feature) : null;
    writeSession(ctx, input, { ...session, start });
  }

  if (!feature) {
    const active = ctx.store
      .listFeatures()
      .filter((f) => f.status !== "done" && f.status !== "abandoned");
    if (active.length === 0) return 0;
    ctx.io.out(
      [
        `local-review (lr) is tracking ${active.length} features in this repo: ` +
          `${active.map((f) => `${f.slug} (${f.status})`).join(", ")}.`,
        "lr commands need `--feature <slug>` (or $LR_FEATURE) to pick one.",
        SKILLS,
      ].join("\n"),
    );
    return 0;
  }

  const round = ctx.store.latestRound(feature.slug);
  const plan =
    feature.currentPlanVersion === null ? "no plan yet" : `plan v${feature.currentPlanVersion}`;
  const threads = ctx.store
    .listThreads(feature.slug)
    .filter((t) => ["proposed", "open", "addressed"].includes(t.status));
  const counts = Object.entries(Object.groupBy(threads, (t) => t.status)).map(
    ([s, ts]) => `${ts!.length} ${s}`,
  );
  const ui = round && uiLink(ctx.jj.root, roundPath(feature.slug, round.n));
  ctx.io.out(
    [
      `local-review (lr) is tracking feature "${feature.slug}" in this repo: ${feature.status}, ` +
        `${plan}${round ? `, round ${round.n} (${round.status})` : ""}.`,
      ...(counts.length ? [`Threads: ${counts.join(", ")}.`] : []),
      ...(ui
        ? [`The developer's review UI (\`lr ui\`) is running; round ${round!.n} is at ${ui}`]
        : []),
      `Next: ${nextStep(ctx, feature, round)}.`,
      SKILLS,
    ].join("\n"),
  );
  return 0;
}

/**
 * Ask before an agent runs lr as a human. Only the developer should record a human's review,
 * verdict, or thread decision.
 */
function preToolUse(input: HookInput, io: Io): number {
  const claimed = input.tool_name === "Bash" ? humanClaim(input.tool_input?.command ?? "") : null;
  if (!claimed) return 0;
  io.out(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason:
          `This runs lr as ${claimed}. Human reviews, verdicts, and thread decisions should come ` +
          "from the developer, so allow it only if they asked for exactly this.",
      },
    }),
  );
  return 0;
}

/** The human identity an lr command claims with `--as` or `LR_ACTOR` (or `lr ui`), if any. */
export function humanClaim(command: string): string | null {
  const actors = [
    ...command.matchAll(/\bLR_ACTOR=(["']?)([^\s"';&|]+)\1/g),
    ...(/(^|[\s;&|(])lr\s/.test(command)
      ? command.matchAll(/--as[=\s]+(["']?)([^\s"';&|]+)\1/g)
      : []),
  ].map((m) => m[2]!);
  const human = actors.find((a) => !a.startsWith("agent:"));
  if (human !== undefined) return human.includes(":") ? human : `human:${human}`;
  // `lr ui` acts as a person, the OS user unless told otherwise, whatever shell starts it.
  if (/(^|[\s;&|(])lr\s+ui\b/.test(command) && actors.length === 0) {
    return `human:${process.env.USER ?? "unknown"}`;
  }
  return null;
}

/**
 * Remind the author to open a review round when it stops after changing the stack in this session,
 * and no round has seen the result. Once per stack state; exit 2 keeps Claude going with the note.
 */
async function stop(ctx: Context, input: HookInput): Promise<number> {
  const option = process.env.CLAUDE_PLUGIN_OPTION_STOP_REMINDER ?? "";
  if (input.stop_hook_active || /^(false|0|no|off)$/i.test(option)) return 0;
  const feature = currentFeature(ctx);
  if (!feature || (feature.status !== "implementing" && feature.status !== "revising")) return 0;

  const session = readSession(ctx, input);
  const key = await stackKey(ctx, feature);
  const round = ctx.store.latestRound(feature.slug);
  const seen = [session.start, session.reminded, round && `${feature.slug}:${commitList(round)}`];
  // No record of how the session started (e.g. the hooks were installed mid-session): stay quiet.
  if (session.start === undefined || key === null || seen.includes(key)) return 0;
  writeSession(ctx, input, { ...session, reminded: key });

  ctx.io.err(
    round
      ? `local-review: the "${feature.slug}" stack has changed since round ${round.n}, and no new ` +
          "round is open. If the revision is done, reply to the threads you worked on " +
          "(`lr reply <id> --addressed ...`) and run `lr review create`. If it isn't, say what's " +
          "left and stop."
      : `local-review: "${feature.slug}" has changes but no review round yet. If the plan's ` +
          "phases are done, run `lr review create`. If they aren't, say what's left and stop.",
  );
  return 2;
}

/**
 * The feature's stack as a comparable string, or null when it's empty or lr can't read it (e.g.
 * it isn't linear yet), which isn't something to nag about.
 */
async function stackKey(ctx: Context, feature: Feature): Promise<string | null> {
  try {
    const snap = await takeSnapshot(ctx.jj, feature.baseRevset, ctx.currentPlan(feature).phases);
    return snap.changes.length ? `${feature.slug}:${commitList(snap)}` : null;
  } catch (e) {
    if (e instanceof LrError) return null;
    throw e;
  }
}

function commitList(stack: { changes: { commitId: string }[] }): string {
  return stack.changes.map((c) => c.commitId).join(",");
}

/** What the hooks remember about one Claude Code session. */
interface SessionState {
  /** The stack when the session started (null: empty, unreadable, or no plan yet). */
  start?: string | null;
  /** The stack the stop hook last reminded about. */
  reminded?: string;
}

function sessionPath(ctx: Context, input: HookInput): string {
  const id = (input.session_id ?? "unknown").replace(/[^\w-]/g, "_");
  return join(repoDir(ctx.jj.root), "sessions", `${id}.json`);
}

function readSession(ctx: Context, input: HookInput): SessionState {
  const path = sessionPath(ctx, input);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SessionState) : {};
}

function writeSession(ctx: Context, input: HookInput, state: SessionState): void {
  mkdirSync(join(repoDir(ctx.jj.root), "sessions"), { recursive: true });
  writeFileSync(sessionPath(ctx, input), JSON.stringify(state));
}
