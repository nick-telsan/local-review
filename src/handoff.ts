import { extname } from "node:path";
import { formatActor } from "./actor.ts";
import { formatLines } from "./anchors.ts";
import type {
  Anchor,
  ChangeSnapshot,
  CheckRun,
  Entry,
  Feature,
  Phase,
  Review,
  Round,
  Thread,
  Verdict,
} from "./model.ts";

/** A heading and the threads under it. Depth 2 = `##`, 3 = `###`. */
export interface HandoffSection {
  title: string;
  depth: 2 | 3;
  threads: Thread[];
}

export interface Handoff {
  feature: string;
  round: number;
  planVersion: number;
  verdict: Verdict;
  /** A human's verdict, or changes requested by agent reviewers when no human has decided. */
  decidedBy: "human" | "agents";
  reviews: Review[];
  /** How many checks ran for this round (0 when skipped or none are configured). */
  checkCount: number;
  failingChecks: CheckRun[];
  /** Every open thread on the feature (not just this round's), in reading order. */
  threads: Thread[];
  sections: HandoffSection[];
  nextSteps: string[];
}

export type HandoffResult = { ready: true; handoff: Handoff } | { ready: false; reason: string };

/**
 * What the author needs to act on after a round's reviews. Open threads are grouped by where the
 * fix goes (general → phase → change) because the author works change by change.
 */
export function buildHandoff(input: {
  feature: Feature;
  round: Round;
  phases: Phase[];
  reviews: Review[];
  checks: CheckRun[];
  threads: Thread[];
}): HandoffResult {
  const { round, phases } = input;
  const reviews = input.reviews.filter((r) => r.state === "submitted");
  const open = input.threads.filter((t) => t.kind === "comment" && t.status === "open");

  let verdict: Verdict;
  let decidedBy: Handoff["decidedBy"];
  if (round.verdict) {
    verdict = round.verdict;
    decidedBy = "human";
  } else if (reviews.length === 0) {
    return { ready: false, reason: `round ${round.n} has no reviews yet` };
  } else if (open.length > 0 || reviews.some((r) => r.verdict === "changes_requested")) {
    verdict = "changes_requested";
    decidedBy = "agents";
  } else {
    return {
      ready: false,
      reason: `agent reviewers have nothing for you on round ${round.n}; waiting on a human verdict`,
    };
  }

  const sections = groupThreads(open, round.changes, phases);
  const threads = sections.flatMap((s) => s.threads);
  const failingChecks = input.checks.filter((c) => c.status !== "pass");

  return {
    ready: true,
    handoff: {
      feature: input.feature.slug,
      round: round.n,
      planVersion: round.planVersion,
      verdict,
      decidedBy,
      reviews,
      checkCount: input.checks.length,
      failingChecks,
      threads,
      sections,
      nextSteps: nextSteps(verdict, threads.length, failingChecks.length),
    },
  };
}

function groupThreads(
  threads: Thread[],
  changes: ChangeSnapshot[],
  phases: Phase[],
): HandoffSection[] {
  const placed = new Set<number>();
  const take = (pred: (a: Anchor) => boolean) => {
    const found = threads.filter((t) => !placed.has(t.id) && pred(t.anchor));
    for (const t of found) placed.add(t.id);
    return found.sort(byLocation);
  };
  const sections: HandoffSection[] = [];

  const general = take((a) => a.kind === "feature");
  if (general.length) sections.push({ title: "General", depth: 2, threads: general });

  const changeSections = (phaseId: number | null) =>
    changes
      .filter((c) => c.phaseId === phaseId)
      .map((c) => ({
        title: `Change \`${c.changeId.slice(0, 8)}\` "${subject(c)}"`,
        depth: 3 as const,
        threads: take((a) => "changeId" in a && a.changeId === c.changeId),
      }))
      .filter((s) => s.threads.length > 0);

  for (const p of phases) {
    const own = take((a) => a.kind === "phase" && a.phaseId === p.id);
    const children = changeSections(p.id);
    if (own.length || children.length) {
      sections.push({
        title: `Phase ${p.id}: ${p.title} (\`${p.bookmark}\`)`,
        depth: 2,
        threads: own,
      });
      sections.push(...children);
    }
  }

  const unassigned = changeSections(null);
  if (unassigned.length) {
    sections.push({ title: "Not in a phase yet", depth: 2, threads: [] }, ...unassigned);
  }

  // Threads on changes that are no longer in the stack (abandoned, squashed away).
  const rest = threads.filter((t) => !placed.has(t.id));
  if (rest.length) {
    sections.push({ title: "Changes no longer in the stack", depth: 2, threads: rest });
  }
  return sections;
}

/** Change-level comments first, then the message, then code by file and line. */
function byLocation(a: Thread, b: Thread): number {
  const rank = { feature: 0, phase: 0, change: 0, message: 1, code: 2 } as const;
  const ra = rank[a.anchor.kind];
  const rb = rank[b.anchor.kind];
  if (ra !== rb) return ra - rb;
  if (a.anchor.kind === "code" && b.anchor.kind === "code") {
    return a.anchor.path.localeCompare(b.anchor.path) || a.anchor.lines[0] - b.anchor.lines[0];
  }
  return a.id - b.id;
}

function nextSteps(verdict: Verdict, open: number, failing: number): string[] {
  if (verdict === "approved" && open === 0) {
    return [
      "Approved with nothing left to address. Finalization (squashing and the PR body) isn't " +
        "in lr yet, so stop here and tell the developer.",
    ];
  }
  return [
    ...(failing ? ["Fix the failing checks listed above."] : []),
    "Write a revised plan that covers every open thread above, and says why for any you " +
      "won't change: `lr plan revise -F <file>`.",
    "Amend the changes the threads are on, in place (`jj edit <change>`, or `jj squash --into " +
      "<change>`). Don't stack fixup commits unless the plan says to.",
    'Reply to every thread: `lr reply <id> --addressed "<what changed>"`, or ' +
      '`lr reply <id> "<why not>"` to push back.',
    verdict === "approved"
      ? "Run `lr review create` for a last look; after that comes finalization."
      : "Run `lr review create` to open the next round.",
  ];
}

// ── markdown ────────────────────────────────────────────────────────────────

export function renderHandoff(h: Handoff): string {
  const out: string[] = [];
  const blocking = h.threads.filter((t) => t.severity === "blocking").length;
  const verdict =
    h.verdict === "approved"
      ? h.threads.length
        ? "approved, with comments"
        : "approved"
      : "changes requested";

  out.push(`# Review handoff: ${h.feature}, round ${h.round}`, "");
  out.push(
    `**Verdict:** ${verdict}${h.decidedBy === "agents" ? " (by agent reviewers; no human verdict yet)" : ""}  `,
  );
  out.push(`**Reviews:** ${h.reviews.map(reviewLabel).join(" · ")}  `);
  out.push(
    h.failingChecks.length
      ? `**Checks:** ${h.failingChecks.map((c) => `✗ ${c.check} @ \`${c.changeId.slice(0, 8)}\` (${c.status}): log at ${c.logPath}`).join("; ")}  `
      : `**Checks:** ${h.checkCount ? `all ${h.checkCount} passing` : "none run"}  `,
  );
  out.push(
    `**Plan:** v${h.planVersion} · ${h.threads.length} open thread(s)${blocking ? ` (${blocking} blocking)` : ""}`,
  );

  for (const r of h.reviews.filter((r) => r.body)) {
    out.push("", `## Reviewer summary (${formatActor(r.reviewer)})`, "", quote(r.body!));
  }

  for (const s of h.sections) {
    out.push("", `${"#".repeat(s.depth)} ${s.title}`);
    for (const t of s.threads) out.push("", ...renderThread(t, s.depth + 1));
  }

  out.push("", "## Next steps", "");
  h.nextSteps.forEach((step, i) => {
    out.push(h.nextSteps.length > 1 ? `${i + 1}. ${step}` : step);
  });
  return `${out.join("\n")}\n`;
}

function renderThread(t: Thread, depth: number): string[] {
  const a = t.anchor;
  const where =
    a.kind === "code"
      ? `\`${a.path}:${formatLines(a.lines)}\` (${a.side})`
      : a.kind === "message"
        ? `commit message${a.lines ? `, line${a.lines[0] === a.lines[1] ? "" : "s"} ${formatLines(a.lines)}` : ""}`
        : null;
  const title = [`#${t.id}`, t.severity, where].filter(Boolean).join(" · ");
  const out = [`${"#".repeat(Math.min(depth, 6))} ${title}`, ""];

  if (a.kind === "code") {
    const width = String(a.lines[1]).length;
    const numbered = a.snippet.map((l, i) => `${String(a.lines[0] + i).padStart(width)} | ${l}`);
    out.push(...fenced(numbered.join("\n"), lang(a.path)), "");
  } else if (a.kind === "message" && a.lines) {
    out.push(...fenced(a.snippet.join("\n"), ""), "");
  }

  const suggestionLang = a.kind === "code" ? lang(a.path) : "";
  out.push(quote(t.entries.map((e) => renderEntry(e, suggestionLang)).join("\n\n")));
  return out;
}

function renderEntry(e: Entry, suggestionLang: string): string {
  const change = e.statusChange ? ` (marked ${e.statusChange.to})` : "";
  const parts = [`**${formatActor(e.author)}**${change}: ${e.body}`];
  if (e.suggestion !== null) {
    parts.push("", "Suggested:", "", ...fenced(e.suggestion, suggestionLang));
  }
  return parts.join("\n");
}

function reviewLabel(r: Review): string {
  const verdict = r.verdict ? r.verdict.replace("_", " ") : "commented";
  return `${formatActor(r.reviewer)}: ${verdict}`;
}

/** A code fence that can't be closed early by backticks in the content. */
function fenced(text: string, language: string): string[] {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return [`${fence}${language}`, text, fence];
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

function lang(path: string): string {
  return extname(path).slice(1);
}

function subject(c: ChangeSnapshot): string {
  return c.description.split("\n")[0] || "(no description)";
}
