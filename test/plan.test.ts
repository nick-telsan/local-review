import { describe, expect, test } from "bun:test";
import { parsePlan } from "../src/plan.ts";

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

  test("rejects invalid YAML", () => {
    expect(() => parsePlan("---\nphases: [\n---\n", "f")).toThrow(/not valid YAML/);
  });
});
