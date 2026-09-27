import { LrError } from "./errors.ts";
import type { Severity, Verdict } from "./model.ts";

/** A comment as written in a review file, before its location is resolved. */
export interface CommentInput {
  change: string | null;
  phase: number | null;
  path: string | null;
  lines: [number, number] | null;
  side: "old" | "new";
  message: boolean;
  /** A final commit's group id (final rounds only). */
  final: string | null;
  /** The PR body (final rounds only). */
  prBody: boolean;
  severity: Severity | null;
  body: string;
  suggestion: string | null;
}

export interface Submission {
  verdict: Verdict | null;
  body: string | null;
  comments: CommentInput[];
}

const VERDICTS: Verdict[] = ["changes_requested", "approved"];
const SEVERITIES: Severity[] = ["blocking", "suggestion", "nit", "question"];
const COMMENT_FIELDS = new Set([
  "change",
  "phase",
  "path",
  "lines",
  "side",
  "message",
  "final",
  "pr_body",
  "severity",
  "body",
  "suggestion",
]);

/**
 * Validate the shape of a review file (see docs/design/data-model.md, "Review submissions").
 * Reports every problem at once so an agent can fix them in one pass.
 */
export function parseSubmission(data: unknown): Submission {
  if (!isRecord(data)) throw new LrError("review must be a JSON object");
  const problems: string[] = [];

  for (const key of Object.keys(data)) {
    if (!["verdict", "body", "comments"].includes(key)) {
      problems.push(`unknown field "${key}" (expected verdict, body, comments)`);
    }
  }

  const verdict = data.verdict ?? null;
  if (verdict !== null && !VERDICTS.includes(verdict as Verdict)) {
    problems.push(`verdict: must be ${VERDICTS.map((v) => `"${v}"`).join(" or ")}, or omitted`);
  }
  const body = data.body ?? null;
  if (body !== null && typeof body !== "string") problems.push("body: must be a string");

  const comments: CommentInput[] = [];
  const raw = data.comments ?? [];
  if (!Array.isArray(raw)) {
    problems.push("comments: must be a list");
  } else {
    raw.forEach((c, i) => {
      const parsed = parseComment(c, `comments[${i}]`, problems);
      if (parsed) comments.push(parsed);
    });
  }

  if (verdict === null && body === null && comments.length === 0 && problems.length === 0) {
    problems.push("review is empty: give a verdict, a body, or comments");
  }
  if (problems.length > 0) {
    throw new LrError(`invalid review:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return { verdict: verdict as Verdict | null, body: body as string | null, comments };
}

function parseComment(c: unknown, where: string, problems: string[]): CommentInput | null {
  if (!isRecord(c)) {
    problems.push(`${where}: must be an object`);
    return null;
  }
  const before = problems.length;
  for (const key of Object.keys(c)) {
    if (!COMMENT_FIELDS.has(key)) {
      problems.push(
        `${where}: unknown field "${key}" (expected ${[...COMMENT_FIELDS].join(", ")})`,
      );
    }
  }

  const str = (key: string): string | null => {
    const v = c[key] ?? null;
    if (v !== null && (typeof v !== "string" || v.length === 0)) {
      problems.push(`${where}.${key}: must be a non-empty string`);
      return null;
    }
    return v as string | null;
  };

  const change = str("change");
  const path = str("path");
  const suggestion = c.suggestion ?? null;
  if (suggestion !== null && typeof suggestion !== "string") {
    problems.push(`${where}.suggestion: must be a string`);
  }
  const body = c.body;
  if (typeof body !== "string" || !body.trim()) problems.push(`${where}.body: required`);

  const phase = c.phase ?? null;
  if (phase !== null && (typeof phase !== "number" || !Number.isInteger(phase))) {
    problems.push(`${where}.phase: must be a phase id (integer)`);
  }

  const rawLines = c.lines ?? null;
  const lines = rawLines === null ? null : parseLines(rawLines);
  if (rawLines !== null && lines === null) {
    problems.push(`${where}.lines: must be a line number or [first, last] (1-based, first ≤ last)`);
  }

  const side = c.side ?? "new";
  if (side !== "new" && side !== "old") problems.push(`${where}.side: must be "new" or "old"`);

  const message = c.message ?? false;
  if (typeof message !== "boolean") problems.push(`${where}.message: must be true or false`);

  // Group ids look like `2` or `2a`; accept a bare number for the former.
  const rawFinal = c.final ?? null;
  const final = typeof rawFinal === "number" ? String(rawFinal) : rawFinal;
  if (final !== null && (typeof final !== "string" || !final)) {
    problems.push(`${where}.final: must be a final commit's group id, e.g. "2" or "2a"`);
  }
  const prBody = c.pr_body ?? false;
  if (typeof prBody !== "boolean") problems.push(`${where}.pr_body: must be true or false`);
  const onFinal = final !== null || prBody === true;

  const severity = c.severity ?? null;
  if (severity !== null && !SEVERITIES.includes(severity as Severity)) {
    problems.push(`${where}.severity: must be one of ${SEVERITIES.join(", ")}`);
  }

  // Which combinations make sense.
  if (change !== null && phase !== null) {
    problems.push(`${where}: give either change or phase, not both`);
  }
  if (message === true && change === null) {
    problems.push(`${where}: a message comment needs the change whose message it's on`);
  }
  if (message === true && path !== null) {
    problems.push(`${where}: a comment is on a file (path) or a commit message, not both`);
  }
  if (path !== null && rawLines === null) problems.push(`${where}: a file comment needs lines`);
  if (onFinal && (change !== null || phase !== null || path !== null || message === true)) {
    problems.push(
      `${where}: final and pr_body comments stand alone (no change, phase, path, or message)`,
    );
  }
  if (final !== null && prBody === true) {
    problems.push(`${where}: a comment is on a final commit or the PR body, not both`);
  }
  if (rawLines !== null && path === null && message !== true && !onFinal) {
    problems.push(
      `${where}: lines only apply to a file (path), a message, a final commit, or the PR body`,
    );
  }
  if (suggestion !== null && rawLines === null) {
    problems.push(`${where}: a suggestion replaces specific lines, so it needs lines`);
  }

  if (problems.length > before) return null;
  return {
    change,
    phase: phase as number | null,
    path,
    lines,
    side: side as "old" | "new",
    message: message as boolean,
    final: final as string | null,
    prBody: prBody as boolean,
    severity: severity as Severity | null,
    body: body as string,
    suggestion: suggestion as string | null,
  };
}

/** `40` or `[40, 42]`: 1-based and inclusive. */
function parseLines(raw: unknown): [number, number] | null {
  const pair: unknown[] | null =
    typeof raw === "number" ? [raw, raw] : Array.isArray(raw) && raw.length === 2 ? raw : null;
  if (!pair) return null;
  const [first, last] = pair;
  if (!isLineNumber(first) || !isLineNumber(last) || first > last) return null;
  return [first, last];
}

function isLineNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
