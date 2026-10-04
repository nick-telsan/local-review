import { describe, expect, test } from "bun:test";
import { parsePlan, planBody } from "../src/plan.ts";

describe("parsePlan", () => {
  test("parses phases, tasks, and body", () => {
    const plan = parsePlan(
      `---
phases:
  - id: 1
    title: Schema + migration
    done_when: migrations apply
    tasks:
      - { id: 1.1, title: Add table }
  - id: 2
    title: Rotation
    bookmark: custom/rotation
---
# Title
`,
      "auth",
    );
    expect(plan.phases).toEqual([
      {
        id: 1,
        title: "Schema + migration",
        bookmark: "auth/1-schema-migration",
        doneWhen: "migrations apply",
        tasks: [{ id: "1.1", title: "Add table" }],
      },
      { id: 2, title: "Rotation", bookmark: "custom/rotation", doneWhen: null, tasks: [] },
    ]);
    expect(plan.body).toBe("# Title\n");
  });

  test("requires frontmatter", () => {
    expect(() => parsePlan("# just markdown", "f")).toThrow(/frontmatter/);
  });

  test("requires phases", () => {
    expect(() => parsePlan("---\ntitle: x\n---\n", "f")).toThrow(/phases/);
  });

  test("reports every problem at once", () => {
    const text = `---
phases:
  - id: 1
    title: A
    bookmark: same
  - id: 1
    title: B
    bookmark: same
  - id: 0
    title: C
  - id: 3
---
`;
    let message = "";
    try {
      parsePlan(text, "f");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("duplicate phase id 1");
    expect(message).toContain("duplicate bookmark same");
    expect(message).toContain("phases[2].id: must be a positive integer");
    expect(message).toContain("phases[3].title: required");
  });

  test("validates phase fields and tasks", () => {
    const text = `---
phases:
  - just a string
  - id: 2
    title: B
    bookmark: 42
  - id: 3
    title: C
    done_when: [not, a, string]
    tasks: nope
  - id: 4
    title: D
    tasks:
      - { title: no id }
      - { id: "4.1" }
      - { id: "4.2", title: ok }
      - { id: "4.2", title: dup }
---
`;
    const message = (() => {
      try {
        parsePlan(text, "f");
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(message).toContain("phases[0]: must be a mapping");
    expect(message).toContain("phases[1].bookmark: must be a string");
    expect(message).toContain("phases[2].done_when: must be a string");
    expect(message).toContain("phases[2].tasks: must be a list");
    expect(message).toContain("phases[3].tasks[0]: needs an id");
    expect(message).toContain("phases[3].tasks[1].title: required");
    expect(message).toContain("phases[3].tasks[3].id: duplicate task id 4.2");
  });

  test("rejects unknown fields at every level", () => {
    const text = `---
phases:
  - id: 1
    title: A
    bookmarks: a
    tasks:
      - { id: "1.1", title: ok, done: true }
      - { title: no id, note: x }
  - id: 0
    titel: B
version: 2
---
`;
    expect(() => parsePlan(text, "f")).toThrow(
      [
        "invalid plan:",
        '  - plan: unknown field "version" (expected phases)',
        '  - phases[0]: unknown field "bookmarks" (expected id, title, bookmark, done_when, tasks)',
        '  - phases[0].tasks[0]: unknown field "done" (expected id, title)',
        '  - phases[0].tasks[1]: unknown field "note" (expected id, title)',
        "  - phases[0].tasks[1]: needs an id",
        '  - phases[1]: unknown field "titel" (expected id, title, bookmark, done_when, tasks)',
        "  - phases[1].id: must be a positive integer",
      ].join("\n"),
    );
    expect(() => parsePlan("---\nphase: []\n---\n", "f")).toThrow(
      'plan: unknown field "phase" (expected phases)\n  - plan frontmatter needs a non-empty',
    );
  });

  test("suggests quoting the value an unquoted comma cut short", () => {
    const text = `---
phases:
  - { id: 1, title: Parse, check, and store, done_when: it works }
  - { id: 2, title: A, done_when: tests pass, lint passes }
  - { id: 3, title: B, bookmark: f/b, x, done_when: a, b }
  - id: 4
    title: C
    tasks:
      - { id: "4.1", title: Add a, b, and c }
      - { id: "4.2", title: "Quoted", extra: null }
      - { id: "4.3", stray, title: After id }
      - { id: "4.4", title: T, note: x, more }
      - { id: "4.5", title: Retry on 502, 503 }
---
`;
    const phase = "(expected id, title, bookmark, done_when, tasks)";
    const task = "(expected id, title)";
    expect(() => parsePlan(text, "f")).toThrow(
      [
        "invalid plan:",
        `  - phases[0]: unknown fields "check", "and store" ${phase}; if title has a comma, quote it: title: "Parse, check, and store"`,
        `  - phases[1]: unknown field "lint passes" ${phase}; if done_when has a comma, quote it: done_when: "tests pass, lint passes"`,
        `  - phases[2]: unknown fields "x", "b" ${phase}; if bookmark has a comma, quote it: bookmark: "f/b, x"; if done_when has a comma, quote it: done_when: "a, b"`,
        `  - phases[3].tasks[0]: unknown fields "b", "and c" ${task}; if title has a comma, quote it: title: "Add a, b, and c"`,
        // An explicit null looks the same, hence the "if".
        `  - phases[3].tasks[1]: unknown field "extra" ${task}; if title has a comma, quote it: title: "Quoted, extra"`,
        // Neither follows a field a comma cuts: one follows id, the other a key with a value.
        `  - phases[3].tasks[2]: unknown field "stray" ${task}`,
        `  - phases[3].tasks[3]: unknown fields "note", "more" ${task}`,
        // "503" is listed before the title, so where it was cut from is lost.
        `  - phases[3].tasks[4]: unknown field "503" ${task}; if a value has a comma, quote it`,
      ].join("\n"),
    );
  });

  test("planBody takes the body without validating", () => {
    expect(planBody("---\nphases: 1\nwhat: ever\n---\n# Plan\n")).toBe("# Plan\n");
    expect(planBody("# no frontmatter\n")).toBe("# no frontmatter\n");
  });

  test("rejects invalid YAML", () => {
    expect(() => parsePlan("---\nphases: [\n---\n", "f")).toThrow(/not valid YAML/);
  });
});
