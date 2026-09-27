// Core data model. See docs/design/data-model.md.

export interface Actor {
  kind: "human" | "agent";
  name: string;
}

export type FeatureStatus =
  | "planning"
  | "implementing"
  | "in_review"
  | "revising"
  | "finalizing"
  | "final_review"
  | "done"
  | "abandoned";

export interface Feature {
  slug: string;
  title: string;
  baseRevset: string;
  status: FeatureStatus;
  currentPlanVersion: number | null;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
}

export interface Phase {
  id: number;
  title: string;
  bookmark: string;
  doneWhen: string | null;
  tasks: Task[];
}

export interface PlanVersion {
  version: number;
  path: string;
  phases: Phase[];
  respondsToRound: number | null;
  createdBy: Actor;
  createdAt: string;
}

export interface ChangeSnapshot {
  changeId: string;
  commitId: string;
  description: string;
  trailers: [key: string, value: string][];
  phaseId: number | null;
  bookmarks: string[];
  conflicted: boolean;
  empty: boolean;
  stats: { files: number; added: number; removed: number };
}

export type RoundStatus = "open" | "closed" | "superseded";

export interface Round {
  n: number;
  jjOpId: string;
  planVersion: number;
  baseCommitId: string;
  changes: ChangeSnapshot[];
  status: RoundStatus;
  verdict: Verdict | null;
  createdBy: Actor;
  createdAt: string;
}

export type CheckStatus = "pending" | "running" | "pass" | "fail" | "error" | "skipped";

export interface CheckRun {
  id: string;
  check: string;
  command: string;
  changeId: string;
  commitId: string;
  trigger: "auto" | "manual";
  status: CheckStatus;
  exitCode: number | null;
  logPath: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type Verdict = "changes_requested" | "approved";

export interface Review {
  id: string;
  round: number;
  reviewer: Actor;
  state: "draft" | "submitted";
  /** null = comments only. */
  verdict: Verdict | null;
  body: string | null;
  createdAt: string;
  submittedAt: string | null;
}

/** A diff endpoint: the stack's base, or a change in the round's snapshot. */
export type RevRef = { changeId: string } | "base";

export type Anchor =
  | { kind: "feature" }
  | { kind: "phase"; phaseId: number }
  | { kind: "change"; changeId: string }
  | {
      kind: "message";
      changeId: string;
      commitId: string;
      lines: [number, number] | null;
      snippet: string[];
    }
  | {
      kind: "code";
      /** The diff the comment was made in. */
      view: { from: RevRef; to: RevRef };
      /** Where the fix belongs. */
      changeId: string;
      commitId: string;
      path: string;
      side: "old" | "new";
      lines: [number, number];
      snippet: string[];
    };

export type Severity = "blocking" | "suggestion" | "nit" | "question";

export type ThreadStatus = "proposed" | "open" | "addressed" | "resolved" | "dismissed";

/**
 * Where a thread's anchor stands, relative to where the comment was made: the same place, the
 * same content somewhere else (other lines or another change), or content that has since changed.
 */
export type AnchorState = "current" | "moved" | "outdated";

export interface Entry {
  id: string;
  author: Actor;
  body: string;
  /** Replacement text for the anchor's lines. */
  suggestion: string | null;
  statusChange: { from: ThreadStatus; to: ThreadStatus } | null;
  round: number | null;
  createdAt: string;
}

export interface Thread {
  /** Per-feature sequence, shown as #12. */
  id: number;
  kind: "comment" | "note";
  /** Where the thread points now; when outdated, the last place it was found. */
  anchor: Anchor;
  /** The round whose snapshot `anchor` refers to. */
  anchorRound: number | null;
  anchorState: AnchorState;
  /** Where the comment was made. Never changes. */
  originalAnchor: Anchor;
  severity: Severity | null;
  status: ThreadStatus;
  reviewId: string | null;
  createdBy: Actor;
  createdInRound: number | null;
  createdAt: string;
  entries: Entry[];
}
