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
  verdict: "changes_requested" | "approved" | null;
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
