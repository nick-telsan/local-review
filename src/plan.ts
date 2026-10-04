import { LrError } from "./errors.ts";
import type { Phase, Task } from "./model.ts";

export interface ParsedPlan {
  phases: Phase[];
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const PLAN_FIELDS = ["phases"];
const PHASE_FIELDS = ["id", "title", "bookmark", "done_when", "tasks"];
const TASK_FIELDS = ["id", "title"];

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
  if (isRecord(data)) checkFields(data, PLAN_FIELDS, "plan", problems);
  const rawPhases = isRecord(data) ? data.phases : undefined;
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    problems.push("plan frontmatter needs a non-empty `phases` list");
    throw invalid(problems);
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
    checkFields(raw, PHASE_FIELDS, where, problems);
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
        if (isRecord(t)) checkFields(t, TASK_FIELDS, tWhere, problems);
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

  if (problems.length > 0) throw invalid(problems);
  return { phases, body: planBody(text) };
}

/**
 * A plan's body, after its frontmatter. Unlike `parsePlan` it doesn't validate, so it reads plans
 * stored before a check was added.
 */
export function planBody(text: string): string {
  const match = FRONTMATTER.exec(text);
  return match ? text.slice(match[0].length) : text;
}

function invalid(problems: string[]): LrError {
  return new LrError(`invalid plan:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

/** Fields whose unquoted value a comma can cut short in a flow mapping. */
const CUTTABLE = ["title", "bookmark", "done_when"];

/**
 * Report the keys of `raw` that aren't in `fields`. In a flow mapping, an unquoted value is cut
 * at its first comma and the rest become keys with no value (`{ title: Add a, b }` has a key
 * "b"), so suggest quoting the field such a run of keys follows, with the value it likely had.
 */
function checkFields(
  raw: Record<string, unknown>,
  fields: string[],
  where: string,
  problems: string[],
): void {
  const keys = Object.keys(raw);
  const unknown = keys.filter((k) => !fields.includes(k));
  if (unknown.length === 0) return;
  const names = unknown.map((k) => `"${k}"`).join(", ");
  problems.push(
    `${where}: unknown field${unknown.length > 1 ? "s" : ""} ${names} (expected ${fields.join(", ")})${quoteHint(raw, keys, fields)}`,
  );
}

function quoteHint(raw: Record<string, unknown>, keys: string[], fields: string[]): string {
  const stray = (k: string) => !fields.includes(k) && raw[k] === null;
  // Objects list integer-like keys first, so where such a key was cut from is lost.
  if (keys.some((k) => stray(k) && /^\d+$/.test(k))) return "; if a value has a comma, quote it";
  const runs = new Map<string, string[]>();
  let field: string | null = null;
  for (const k of keys) {
    if (fields.includes(k)) {
      field = CUTTABLE.includes(k) && typeof raw[k] === "string" ? k : null;
    } else if (field !== null && stray(k)) {
      runs.set(field, [...(runs.get(field) ?? []), k]);
    } else {
      field = null;
    }
  }
  return [...runs]
    .map(([f, run]) => {
      const value = JSON.stringify([raw[f], ...run].join(", "));
      return `; if ${f} has a comma, quote it: ${f}: ${value}`;
    })
    .join("");
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
