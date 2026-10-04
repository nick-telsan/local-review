import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, type Io } from "../context.ts";
import { LrError } from "../errors.ts";
import { Jj } from "../jj.ts";
import type { Feature } from "../model.ts";
import { repoDir } from "../paths.ts";
import { splitCommand } from "../shell.ts";
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

/**
 * The human identity a Bash command runs lr as, with `--as` or `LR_ACTOR` (or `lr ui`), if any.
 * It reads the command as the shell would, so text in a quoted argument or a heredoc doesn't count.
 */
export function humanClaim(command: string): string | null {
  const claims: Claims = { actors: [], ui: false };
  return claimed(collectClaims(command, claims, 0) ? claims : textClaims(command));
}

interface Claims {
  /** Every `--as` given to lr, and every `LR_ACTOR` set. */
  actors: string[];
  /** Whether it runs `lr ui`. */
  ui: boolean;
}

function claimed({ actors, ui }: Claims): string | null {
  const human = actors.find((a) => !a.startsWith("agent:"));
  if (human !== undefined) return human.includes(":") ? human : `human:${human}`;
  // `lr ui` acts as a person, the OS user unless told otherwise, whatever shell starts it.
  if (ui && actors.length === 0) return `human:${process.env.USER ?? "unknown"}`;
  return null;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_DEPTH = 8;

/**
 * Gather the claims of each lr call in a script, and in the scripts it runs: command
 * substitutions, `sh -c`, `eval`, and heredocs fed to a shell. False when the script can't be
 * read for certain: a shell runs a script that isn't in the text (`… | sh`), or the text ends
 * inside a quote, substitution or heredoc. The caller then falls back to `textClaims`.
 */
function collectClaims(script: string, claims: Claims, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const { commands, substitutions, unterminated } = splitCommand(script);
  if (unterminated) return false;
  const scripts = [...substitutions];
  for (const { words, stdin } of commands) {
    // lr, a shell or eval can start anywhere in a command: `env … lr`, `bun run lr`, `xargs sh -c`.
    const at = words.findIndex((w) => {
      const name = basename(w);
      return name === "lr" || name === "eval" || SHELLS.has(name);
    });
    // Before the program, a word can only be its environment (`sudo`, `env -u X`, `do`, `time`).
    for (const w of at === -1 ? assignments(words) : words.slice(0, at)) {
      if (w.startsWith("LR_ACTOR=") && w.length > "LR_ACTOR=".length) {
        claims.actors.push(w.slice("LR_ACTOR=".length));
      }
    }
    if (at === -1) continue;
    const name = basename(words[at]!);
    const args = words.slice(at + 1);
    if (name === "lr") {
      lrClaims(args, claims);
    } else if (name === "eval") {
      scripts.push(args.join(" "));
    } else {
      const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
      if (c !== -1) scripts.push(args[c + 1] ?? "");
      else if (stdin.length > 0) scripts.push(...stdin);
      // A shell with no script file reads one from a pipe.
      else if (args.every((a) => a.startsWith("-"))) return false;
    }
  }
  return scripts.every((s) => collectClaims(s, claims, depth + 1));
}

const SETTERS = new Set(["env", "export", "declare", "typeset", "local", "readonly"]);
const KEYWORDS = new Set(["!", "{", "time", "if", "then", "elif", "else", "do", "while", "until"]);

/**
 * The assignments a command makes: before its program, or as the arguments of `env`, `export` and
 * the like. Elsewhere, such as in grep's pattern, `NAME=value` is text.
 */
function assignments(words: string[]): string[] {
  const found: string[] = [];
  for (const w of words) {
    if (KEYWORDS.has(w) || SETTERS.has(basename(w)) || w.startsWith("-")) continue;
    if (!/^[A-Za-z_]\w*=/.test(w)) break;
    found.push(w);
  }
  return found;
}

/** An lr call's own claims: `--as` among its options (before any `--`), and `lr ui`. */
function lrClaims(args: string[], claims: Claims): void {
  const end = args.indexOf("--");
  const own = end === -1 ? args : args.slice(0, end);
  if (own[0] === "ui") claims.ui = true;
  own.forEach((a, i) => {
    if (a === "--as" && i + 1 < own.length) claims.actors.push(own[i + 1]!);
    else if (a.startsWith("--as=")) claims.actors.push(a.slice("--as=".length));
  });
}

/** Claims found by matching the whole text, for scripts lr can't see. Errs toward asking. */
function textClaims(command: string): Claims {
  return {
    actors: [
      ...command.matchAll(/\bLR_ACTOR=(["']?)([^\s"';&|]+)\1/g),
      ...(/\blr\s/.test(command) ? command.matchAll(/--as[=\s]+(["']?)([^\s"';&|]+)\1/g) : []),
    ].map((m) => m[2]!),
    ui: /\blr\s+ui\b/.test(command),
  };
}

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

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
