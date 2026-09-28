import { extname } from "node:path";
import { formatActor } from "./actor.ts";
import { formatLines } from "./anchors.ts";
import { describeGap, type PlanGap, planGaps } from "./coverage.ts";
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
  /** A final round reviews the squash groups, their messages, and the PR body. */
  kind: Round["kind"];
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
  /** Where a code round's changes and its plan's tasks don't line up (see `planGaps`). */
  planGaps: { gap: PlanGap; text: string }[];
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
  // A note is open once someone other than its author replies to it, and that needs an answer.
  const open = input.threads.filter((t) => t.status === "open");

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
  const planGapsFound = round.kind === "code" ? planGaps(round, phases) : [];
  const threads = sections.flatMap((s) => s.threads);
  const failingChecks = input.checks.filter((c) => c.status !== "pass");

  return {
    ready: true,
    handoff: {
      feature: input.feature.slug,
      round: round.n,
      kind: round.kind,
      planVersion: round.planVersion,
      verdict,
      decidedBy,
      reviews,
      checkCount: input.checks.length,
      failingChecks,
      threads,
      sections,
      planGaps: planGapsFound.map((gap) => ({ gap, text: describeGap(gap, round.changes) })),
      nextSteps: nextSteps(
        round.kind,
        verdict,
        threads.length,
        failingChecks.length,
        planGapsFound.length,
      ),
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
  const finals = take((a) => a.kind === "final");
  if (finals.length) sections.push({ title: "Final commit messages", depth: 2, threads: finals });
  const prBody = take((a) => a.kind === "pr_body");
  if (prBody.length) sections.push({ title: "PR body", depth: 2, threads: prBody });
  const plan = take((a) => a.kind === "plan");
  if (plan.length) sections.push({ title: "The plan", depth: 2, threads: plan });

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

  // Threads on changes that were abandoned, or on phases the plan dropped.
  const rest = threads.filter((t) => !placed.has(t.id));
  if (rest.length) {
    sections.push({ title: "No longer in the stack or plan", depth: 2, threads: rest });
  }
  return sections;
}

/** Change-level comments first, then the message, then code by file and line. */
function byLocation(a: Thread, b: Thread): number {
  const rank = {
    feature: 0,
    phase: 0,
    change: 0,
    message: 1,
    final: 1,
    pr_body: 1,
    plan: 1,
    code: 2,
  };
  const ra = rank[a.anchor.kind];
  const rb = rank[b.anchor.kind];
  if (ra !== rb) return ra - rb;
  if (a.anchor.kind === "code" && b.anchor.kind === "code") {
    return a.anchor.path.localeCompare(b.anchor.path) || a.anchor.lines[0] - b.anchor.lines[0];
  }
  if (a.anchor.kind === "final" && b.anchor.kind === "final") {
    return a.anchor.groupId.localeCompare(b.anchor.groupId) || a.id - b.id;
  }
  return a.id - b.id;
}

function nextSteps(
  kind: Round["kind"],
  verdict: Verdict,
  open: number,
  failing: number,
  gaps: number,
): string[] {
  if (kind === "final") {
    if (verdict === "approved" && open === 0) {
      return ["The final commits are approved. Run `lr final apply` to squash the stack."];
    }
    return [
      "Edit the drafts the threads are on: `lr final message <group> -F <file>` or " +
        "`lr final pr-body -F <file>` (`lr final show` has the current text).",
      'Reply to every thread: `lr reply <id> --addressed "<what changed>"`, or ' +
        '`lr reply <id> "<why not>"` to push back.',
      "Run `lr review create --final` for the next final round.",
    ];
  }
  if (verdict === "approved" && open === 0) {
    return [
      "Approved with nothing left to address. Finalize: read `lr final show --json`, draft a " +
        "message for each final commit (`lr final message <group> -F <file>`) and the PR body " +
        "(`lr final pr-body -F <file>`), then run `lr review create --final`.",
    ];
  }
  return [
    ...(failing ? ["Fix the failing checks listed above."] : []),
    ...(gaps
      ? [
          "Close the plan gaps listed above: implement the missing tasks, add a " +
            "`Plan-Task: <id>` trailer to the change that does each, or drop the task in the " +
            "revised plan and say why.",
        ]
      : []),
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

  out.push(
    `# Review handoff: ${h.feature}, ${h.kind === "final" ? "final " : ""}round ${h.round}`,
    "",
  );
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

  if (h.planGaps.length) {
    out.push("", `## Plan gaps (Plan-Task trailers vs plan v${h.planVersion})`, "");
    for (const g of h.planGaps) out.push(`- ${g.text}`);
  }

  out.push("", "## Next steps", "");
  h.nextSteps.forEach((step, i) => {
    out.push(h.nextSteps.length > 1 ? `${i + 1}. ${step}` : step);
  });
  return `${out.join("\n")}\n`;
}

function renderThread(t: Thread, depth: number): string[] {
  const a = t.anchor;
  const lineRef = (l: [number, number] | null) =>
    l ? `, line${l[0] === l[1] ? "" : "s"} ${formatLines(l)}` : "";
  const where =
    a.kind === "code"
      ? `\`${a.path}:${formatLines(a.lines)}\` (${a.side})`
      : a.kind === "message"
        ? `commit message${lineRef(a.lines)}`
        : a.kind === "final"
          ? `final commit ${a.groupId}${lineRef(a.lines)}`
          : a.kind === "pr_body"
            ? `PR body${lineRef(a.lines)}`
            : a.kind === "plan"
              ? `plan v${a.version}${lineRef(a.lines)}`
              : null;
  const outdated = t.anchorState === "outdated";
  const title = [
    `#${t.id}`,
    t.kind === "note" ? "your note" : t.severity,
    where,
    outdated && "outdated",
  ]
    .filter(Boolean)
    .join(" · ");
  const out = [`${"#".repeat(Math.min(depth, 6))} ${title}`, ""];

  const hasText =
    a.kind === "message" || a.kind === "final" || a.kind === "pr_body" || a.kind === "plan";
  if (outdated && (a.kind === "code" || hasText)) {
    const since = t.anchorRound === null ? "the note was written" : `round ${t.anchorRound}`;
    out.push(`_This changed after ${since}. As it was then:_`, "");
  }
  if (a.kind === "code") {
    const width = String(a.lines[1]).length;
    const numbered = a.snippet.map((l, i) => `${String(a.lines[0] + i).padStart(width)} | ${l}`);
    out.push(...fenced(numbered.join("\n"), lang(a.path)), "");
  } else if (hasText && (a.lines || outdated)) {
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
