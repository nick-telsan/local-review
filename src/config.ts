import { join } from "node:path";
import { LrError } from "./errors.ts";

export type CheckTarget = "tip" | "bookmarks" | "changes";

export interface CheckConfig {
  name: string;
  run: string;
  at: CheckTarget;
  timeoutMs: number;
  /** After SIGTERM (a timeout, or processes left running), how long before SIGKILL. */
  killAfterMs: number;
}

export interface ReviewConfig {
  /** Agent reviewers' comments start `proposed` and need a human to accept them. */
  triageAgentComments: boolean;
}

/** Repo-relative paths to what the author follows when drafting final messages and the PR body. */
export interface FinalConfig {
  commitGuidelines: string | null;
  /** Defaults to `.github/pull_request_template.md` when that file exists. */
  prTemplate: string | null;
}

export interface UiConfig {
  /** The port `lr ui` serves on; null for the default, which is derived from the repo's path. */
  port: number | null;
}

export interface RepoConfig {
  /** Runs in the check workspace before checks at each commit (e.g. `bun install`). */
  setup: string | null;
  setupKillAfterMs: number;
  checks: CheckConfig[];
  review: ReviewConfig;
  final: FinalConfig;
  ui: UiConfig;
}

const DEFAULT_REVIEW: ReviewConfig = { triageAgentComments: false };
const GITHUB_PR_TEMPLATE = ".github/pull_request_template.md";

export const CONFIG_FILE = ".local-review.toml";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Long enough for a test suite to tear down what it started (containers, databases). */
const DEFAULT_KILL_AFTER_MS = 30_000;

export async function loadRepoConfig(root: string): Promise<RepoConfig> {
  const file = Bun.file(join(root, CONFIG_FILE));
  const defaultTemplate = (await Bun.file(join(root, GITHUB_PR_TEMPLATE)).exists())
    ? GITHUB_PR_TEMPLATE
    : null;
  const final: FinalConfig = { commitGuidelines: null, prTemplate: defaultTemplate };
  if (!(await file.exists())) {
    return {
      setup: null,
      setupKillAfterMs: DEFAULT_KILL_AFTER_MS,
      checks: [],
      review: DEFAULT_REVIEW,
      final,
      ui: { port: null },
    };
  }

  let data: Record<string, unknown>;
  try {
    data = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
  } catch (e) {
    throw new LrError(`${CONFIG_FILE}: ${(e as Error).message}`);
  }

  const problems: string[] = [];
  const setup = data.setup ?? null;
  if (setup !== null && typeof setup !== "string") problems.push("setup: must be a string");
  const duration = (value: unknown, where: string, fallback: number): number | null => {
    if (value === undefined) return fallback;
    const parsed = typeof value === "string" ? parseDuration(value) : null;
    if (parsed === null) problems.push(`${where}: expected a duration like "90s" or "10m"`);
    return parsed;
  };
  const setupKillAfterMs =
    duration(data.setup_kill_after, "setup_kill_after", DEFAULT_KILL_AFTER_MS) ?? 0;

  const checks: CheckConfig[] = [];
  const names = new Set<string>();
  const rawChecks = data.checks ?? [];
  if (!Array.isArray(rawChecks)) {
    problems.push("checks: must be an array of tables ([[checks]])");
  } else {
    rawChecks.forEach((raw: Record<string, unknown>, i) => {
      const where = `checks[${i}]`;
      if (typeof raw.name !== "string" || !raw.name) {
        problems.push(`${where}.name: required`);
        return;
      }
      if (names.has(raw.name)) problems.push(`${where}.name: duplicate check "${raw.name}"`);
      names.add(raw.name);
      if (typeof raw.run !== "string" || !raw.run) {
        problems.push(`${where}.run: required`);
        return;
      }
      const at = raw.at ?? "tip";
      if (at !== "tip" && at !== "bookmarks" && at !== "changes") {
        problems.push(`${where}.at: must be "tip", "bookmarks", or "changes"`);
        return;
      }
      const timeoutMs = duration(raw.timeout, `${where}.timeout`, DEFAULT_TIMEOUT_MS);
      const killAfterMs = duration(raw.kill_after, `${where}.kill_after`, DEFAULT_KILL_AFTER_MS);
      if (timeoutMs === null || killAfterMs === null) return;
      checks.push({ name: raw.name, run: raw.run, at, timeoutMs, killAfterMs });
    });
  }

  const review = { ...DEFAULT_REVIEW };
  const rawReview = data.review ?? {};
  if (typeof rawReview !== "object" || rawReview === null || Array.isArray(rawReview)) {
    problems.push("review: must be a table ([review])");
  } else {
    const triage = (rawReview as Record<string, unknown>).triage_agent_comments;
    if (triage !== undefined && typeof triage !== "boolean") {
      problems.push("review.triage_agent_comments: must be true or false");
    } else if (triage !== undefined) {
      review.triageAgentComments = triage;
    }
  }

  const rawFinal = data.final ?? {};
  if (typeof rawFinal !== "object" || rawFinal === null || Array.isArray(rawFinal)) {
    problems.push("final: must be a table ([final])");
  } else {
    for (const [key, field] of [
      ["commit_guidelines", "commitGuidelines"],
      ["pr_template", "prTemplate"],
    ] as const) {
      const value = (rawFinal as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value) {
        problems.push(`final.${key}: must be a path relative to the repo root`);
      } else if (!(await Bun.file(join(root, value)).exists())) {
        problems.push(`final.${key}: ${value} doesn't exist`);
      } else {
        final[field] = value;
      }
    }
  }

  const ui: UiConfig = { port: null };
  const rawUi = data.ui ?? {};
  if (typeof rawUi !== "object" || rawUi === null || Array.isArray(rawUi)) {
    problems.push("ui: must be a table ([ui])");
  } else {
    const port = (rawUi as Record<string, unknown>).port;
    if (port !== undefined && !isPort(port)) {
      problems.push("ui.port: must be a port number (1-65535)");
    } else if (port !== undefined) {
      ui.port = port as number;
    }
  }

  if (problems.length > 0) {
    throw new LrError(`${CONFIG_FILE}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return { setup: setup as string | null, setupKillAfterMs, checks, review, final, ui };
}

export function isPort(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536;
}

export function parseDuration(text: string): number | null {
  const m = /^(\d+)(ms|s|m|h)$/.exec(text.trim());
  if (!m) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
  return Number(m[1]) * unit;
}

/** The inverse of `parseDuration`, in the largest unit that fits: `90s`, `10m`, `300ms`. */
export function formatDuration(ms: number): string {
  for (const [unit, size] of [
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}
