// How a round's changes line up with its plan, through `Plan-Task: <id>` trailers. Optional:
// until some change names a task, there's nothing to measure, and no gaps are reported.
import type { ChangeSnapshot, Phase, Round, Task } from "./model.ts";

/** A task, and the changes that say they implement it (`Plan-Task: <id>`), in stack order. */
export interface TaskCoverage {
  task: Task;
  changeIds: string[];
}

export interface PhaseCoverage {
  phaseId: number;
  tasks: TaskCoverage[];
  /** The changes in the phase (by its bookmark), in stack order. */
  changeIds: string[];
  /** Changes in the phase that name no task. */
  untasked: string[];
}

/** How the round's changes line up with its plan. */
export interface PlanCoverage {
  phases: PhaseCoverage[];
  /** Changes naming a task the plan doesn't have. */
  unknownTasks: { changeId: string; taskId: string }[];
  /** Changes past the last phase's bookmark. */
  unphased: string[];
  /** Whether any change names a task: without that, there's no coverage to show. */
  linked: boolean;
}

/** Something between the plan and the stack that the author should look at. */
export type PlanGap =
  | { kind: "task"; phaseId: number; taskId: string; title: string }
  | { kind: "unknown_task"; changeId: string; taskId: string }
  | { kind: "untasked_change"; phaseId: number; changeId: string };

/** The task ids a change names in `Plan-Task` trailers (`1.1`, or several: `1.1, 1.2`). */
export function taskIds(change: ChangeSnapshot): string[] {
  return change.trailers
    .filter(([key]) => key.toLowerCase() === "plan-task")
    .flatMap(([, value]) => value.split(/[\s,]+/))
    .filter(Boolean);
}

/** A round, or a snapshot about to become one. */
type Stack = Pick<Round, "changes">;

export function coverage(round: Stack, phases: Phase[]): PlanCoverage {
  const known = new Set(phases.flatMap((p) => p.tasks.map((t) => t.id)));
  const named = round.changes.map((c) => ({ id: c.changeId, tasks: taskIds(c), phase: c.phaseId }));
  return {
    phases: phases.map((p) => {
      const inPhase = named.filter((c) => c.phase === p.id);
      return {
        phaseId: p.id,
        tasks: p.tasks.map((task) => ({
          task,
          changeIds: named.filter((c) => c.tasks.includes(task.id)).map((c) => c.id),
        })),
        changeIds: inPhase.map((c) => c.id),
        untasked: inPhase.filter((c) => c.tasks.length === 0).map((c) => c.id),
      };
    }),
    unknownTasks: named.flatMap((c) =>
      c.tasks.filter((t) => !known.has(t)).map((taskId) => ({ changeId: c.id, taskId })),
    ),
    unphased: named.filter((c) => c.phase === null).map((c) => c.id),
    linked: named.some((c) => c.tasks.length > 0),
  };
}

/**
 * Tasks no change names, task ids the plan doesn't have, and changes that name no task; none
 * until some change names a task. (Changes in no phase are reported by `lr review create`.)
 */
export function planGaps(round: Stack, phases: Phase[]): PlanGap[] {
  const c = coverage(round, phases);
  if (!c.linked) return [];
  return [
    ...c.phases.flatMap((p) =>
      p.tasks
        .filter((t) => t.changeIds.length === 0)
        .map(
          (t): PlanGap => ({
            kind: "task",
            phaseId: p.phaseId,
            taskId: t.task.id,
            title: t.task.title,
          }),
        ),
    ),
    ...c.unknownTasks.map((u): PlanGap => ({ kind: "unknown_task", ...u })),
    ...c.phases.flatMap((p) =>
      p.untasked.map(
        (changeId): PlanGap => ({ kind: "untasked_change", phaseId: p.phaseId, changeId }),
      ),
    ),
  ];
}

/** One gap as a line of text, e.g. `task 2.2 "Wire into auth" (phase 2): no change names it`. */
export function describeGap(gap: PlanGap, changes: ChangeSnapshot[]): string {
  const change = (id: string) => {
    const c = changes.find((x) => x.changeId === id);
    return `${id.slice(0, 8)} "${c?.description.split("\n")[0] || "(no description)"}"`;
  };
  switch (gap.kind) {
    case "task":
      return `task ${gap.taskId} "${gap.title}" (phase ${gap.phaseId}): no change names it`;
    case "unknown_task":
      return `${change(gap.changeId)} names task ${gap.taskId}, which the plan doesn't have`;
    case "untasked_change":
      return `${change(gap.changeId)} (phase ${gap.phaseId}) names no task`;
  }
}
