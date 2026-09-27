import { LrError } from "./errors.ts";
import type { Phase, Task } from "./model.ts";

export interface ParsedPlan {
  phases: Phase[];
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse and validate a plan: markdown with YAML frontmatter listing phases.
 * Phases without a `bookmark` get `<feature>/<id>-<slugified title>`.
 */
export function parsePlan(text: string, featureSlug: string): ParsedPlan {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new LrError("plan must start with YAML frontmatter (--- … ---)");

  let data: unknown;
  try {
    data = Bun.YAML.parse(match[1]!);
  } catch (e) {
    throw new LrError(`plan frontmatter is not valid YAML: ${(e as Error).message}`);
  }

  const problems: string[] = [];
  const rawPhases = isRecord(data) ? data.phases : undefined;
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    throw new LrError("plan frontmatter needs a non-empty `phases` list");
  }

  const phases: Phase[] = [];
  const phaseIds = new Set<number>();
  const bookmarks = new Set<string>();
  const taskIds = new Set<string>();

  rawPhases.forEach((raw, i) => {
    const where = `phases[${i}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: must be a mapping`);
      return;
    }
    const id = raw.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      problems.push(`${where}.id: must be a positive integer`);
      return;
    }
    if (phaseIds.has(id)) problems.push(`${where}.id: duplicate phase id ${id}`);
    phaseIds.add(id);

    const title = raw.title;
    if (typeof title !== "string" || !title.trim()) {
      problems.push(`${where}.title: required`);
      return;
    }

    const bookmark = raw.bookmark ?? `${featureSlug}/${id}-${slugify(title)}`;
    if (typeof bookmark !== "string" || !bookmark.trim()) {
      problems.push(`${where}.bookmark: must be a string`);
      return;
    }
    if (bookmarks.has(bookmark)) problems.push(`${where}.bookmark: duplicate bookmark ${bookmark}`);
    bookmarks.add(bookmark);

    const doneWhen = raw.done_when ?? null;
    if (doneWhen !== null && typeof doneWhen !== "string") {
      problems.push(`${where}.done_when: must be a string`);
    }

    const tasks: Task[] = [];
    const rawTasks = raw.tasks ?? [];
    if (!Array.isArray(rawTasks)) {
      problems.push(`${where}.tasks: must be a list`);
    } else {
      rawTasks.forEach((t, j) => {
        const tWhere = `${where}.tasks[${j}]`;
        if (!isRecord(t) || (typeof t.id !== "string" && typeof t.id !== "number")) {
          problems.push(`${tWhere}: needs an id`);
          return;
        }
        const taskId = String(t.id);
        if (typeof t.title !== "string" || !t.title.trim()) {
          problems.push(`${tWhere}.title: required`);
          return;
        }
        if (taskIds.has(taskId)) problems.push(`${tWhere}.id: duplicate task id ${taskId}`);
        taskIds.add(taskId);
        tasks.push({ id: taskId, title: t.title });
      });
    }

    phases.push({
      id,
      title,
      bookmark,
      doneWhen: typeof doneWhen === "string" ? doneWhen : null,
      tasks,
    });
  });

  if (problems.length > 0) {
    throw new LrError(`invalid plan:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return { phases, body: text.slice(match[0].length) };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
