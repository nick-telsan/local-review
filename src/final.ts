import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LrError } from "./errors.ts";
import type { ChangeSnapshot, Feature, FinalSnapshot, Phase, Round } from "./model.ts";

/** A run of changes in one phase that becomes one commit of the finished feature. */
export interface SquashGroup {
  id: string;
  phase: Phase;
  changes: ChangeSnapshot[];
}

/** Statuses in which a feature's final commits can be drafted and reviewed. */
export const FINAL_STATUSES: Feature["status"][] = ["finalizing", "final_review", "approved"];

/**
 * One group per phase, split where a cut starts a new group. Groups are named by phase id, with a
 * letter when a phase has several (`2a`, `2b`). Every change must be in a phase.
 */
export function squashGroups(
  changes: ChangeSnapshot[],
  phases: Phase[],
  cuts: string[],
): SquashGroup[] {
  const loose = changes.filter((c) => c.phaseId === null);
  if (loose.length > 0) {
    throw new LrError(
      `every change needs a phase before finalizing; these aren't in one: ` +
        `${loose.map((c) => c.changeId.slice(0, 8)).join(", ")} (move a phase bookmark to cover them)`,
    );
  }
  const groups: SquashGroup[] = [];
  for (const phase of phases) {
    const runs: ChangeSnapshot[][] = [];
    for (const c of changes.filter((c) => c.phaseId === phase.id)) {
      if (runs.length === 0 || cuts.includes(c.changeId)) runs.push([c]);
      else runs.at(-1)!.push(c);
    }
    runs.forEach((run, i) => {
      const id = runs.length === 1 ? String(phase.id) : `${phase.id}${String.fromCharCode(97 + i)}`;
      groups.push({ id, phase, changes: run });
    });
  }
  return groups;
}

/**
 * Draft messages and the PR body, as plain files in the feature's `final/` directory so the
 * developer can edit them directly. Texts are stored with surrounding whitespace trimmed.
 */
export class Drafts {
  constructor(private readonly dir: string) {}

  messagePath(groupId: string): string {
    return join(this.dir, "messages", `${groupId}.md`);
  }

  get prBodyPath(): string {
    return join(this.dir, "pr.md");
  }

  message(groupId: string): string | null {
    return read(this.messagePath(groupId));
  }

  setMessage(groupId: string, text: string): void {
    write(this.messagePath(groupId), text);
  }

  clearMessage(groupId: string): boolean {
    const path = this.messagePath(groupId);
    const existed = existsSync(path);
    rmSync(path, { force: true });
    return existed;
  }

  prBody(): string | null {
    return read(this.prBodyPath);
  }

  setPrBody(text: string): void {
    write(this.prBodyPath, text);
  }

  /** What differs between the drafts and a final round's snapshot, e.g. `message 2a`. */
  changedSince(final: FinalSnapshot): string[] {
    const changed = final.groups
      .filter((g) => this.message(g.id) !== g.message)
      .map((g) => `message ${g.id}`);
    if (this.prBody() !== final.prBody) changed.push("PR body");
    return changed;
  }
}

function read(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  return text || null;
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${text.trim()}\n`);
}

/** Check a draft before saving it. Returns warnings; throws if it can't be used at all. */
export function checkMessage(text: string, what: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) throw new LrError(`${what} is empty`);
  const subject = trimmed.split("\n")[0]!;
  const warnings: string[] = [];
  if (subject.length > 72) warnings.push(`the subject is ${subject.length} characters (over 72)`);
  if (trimmed.split("\n")[1]?.trim()) warnings.push("the subject isn't followed by a blank line");
  return warnings;
}

/** Commit ids of a stack, for comparing one against another. */
export function stackCommits(stack: { changes: ChangeSnapshot[] }): string {
  return stack.changes.map((c) => c.commitId).join(",");
}

/** The code round a final round must build on: the latest code round, approved by a human. */
export function approvedRound(latestCode: Round | null, feature: Feature): Round {
  if (!FINAL_STATUSES.includes(feature.status) || latestCode?.verdict !== "approved") {
    throw new LrError(
      `feature "${feature.slug}" is ${feature.status}; finalization starts once a human approves ` +
        "a round (see `lr status`)",
    );
  }
  return latestCode;
}
