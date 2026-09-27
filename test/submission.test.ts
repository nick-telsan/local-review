import { describe, expect, test } from "bun:test";
import { parseSubmission } from "../src/submission.ts";

const problemsOf = (data: unknown): string => {
  try {
    parseSubmission(data);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("parseSubmission", () => {
  test("a verdict alone is a review", () => {
    expect(parseSubmission({ verdict: "approved" })).toEqual({
      verdict: "approved",
      body: null,
      comments: [],
    });
  });

  test("comments get defaults, and a single line becomes a range", () => {
    const { comments } = parseSubmission({
      body: "Summary",
      comments: [
        { body: "general" },
        { change: "kxqp", path: "src/a.ts", lines: 40, severity: "blocking", body: "x" },
        { change: "kxqp", message: true, lines: [1, 2], suggestion: "Add a", body: "y" },
        { phase: 2, path: "b.ts", lines: [3, 5], side: "old", body: "z" },
      ],
    });
    expect(comments[0]).toEqual({
      change: null,
      phase: null,
      path: null,
      lines: null,
      side: "new",
      message: false,
      final: null,
      prBody: false,
      severity: null,
      body: "general",
      suggestion: null,
    });
    expect(comments[1]).toMatchObject({ lines: [40, 40], severity: "blocking" });
    expect(comments[2]).toMatchObject({ message: true, lines: [1, 2], suggestion: "Add a" });
    expect(comments[3]).toMatchObject({ phase: 2, side: "old", lines: [3, 5] });
  });

  test("rejects non-objects and empty reviews", () => {
    expect(problemsOf([])).toContain("must be a JSON object");
    expect(problemsOf({})).toContain("review is empty");
  });

  test("reports every top-level problem at once", () => {
    const message = problemsOf({ verdict: "lgtm", body: 3, comments: {}, extra: true });
    expect(message).toContain('unknown field "extra"');
    expect(message).toContain('verdict: must be "changes_requested" or "approved"');
    expect(message).toContain("body: must be a string");
    expect(message).toContain("comments: must be a list");
  });

  test("validates each comment's fields", () => {
    const message = problemsOf({
      comments: [
        "nope",
        { body: "x", line: 3 },
        { body: "" },
        { body: "x", change: "" },
        { body: "x", phase: 1.5 },
        { body: "x", path: "a", lines: 0 },
        { body: "x", path: "a", lines: [5, 3] },
        { body: "x", path: "a", lines: [1] },
        { body: "x", path: "a", lines: 1, side: "left" },
        { body: "x", change: "k", message: "yes" },
        { body: "x", severity: "urgent" },
        { body: "x", suggestion: 3, path: "a", lines: 1 },
      ],
    });
    expect(message).toContain("comments[0]: must be an object");
    expect(message).toContain('comments[1]: unknown field "line"');
    expect(message).toContain("comments[2].body: required");
    expect(message).toContain("comments[3].change: must be a non-empty string");
    expect(message).toContain("comments[4].phase: must be a phase id");
    expect(message).toContain("comments[5].lines:");
    expect(message).toContain("comments[6].lines:");
    expect(message).toContain("comments[7].lines:");
    expect(message).toContain('comments[8].side: must be "new" or "old"');
    expect(message).toContain("comments[9].message: must be true or false");
    expect(message).toContain("comments[10].severity: must be one of");
    expect(message).toContain("comments[11].suggestion: must be a string");
  });

  test("rejects combinations that don't make sense", () => {
    const message = problemsOf({
      comments: [
        { body: "x", change: "k", phase: 1 },
        { body: "x", message: true },
        { body: "x", change: "k", message: true, path: "a", lines: 1 },
        { body: "x", path: "a" },
        { body: "x", lines: 3 },
        { body: "x", change: "k", suggestion: "y" },
      ],
    });
    expect(message).toContain("comments[0]: give either change or phase");
    expect(message).toContain("comments[1]: a message comment needs the change");
    expect(message).toContain("comments[2]: a comment is on a file (path) or a commit message");
    expect(message).toContain("comments[3]: a file comment needs lines");
    expect(message).toContain("comments[4]: lines only apply");
    expect(message).toContain("comments[5]: a suggestion replaces specific lines");
  });

  test("final and pr_body comments", () => {
    const { comments } = parseSubmission({
      comments: [
        { final: 2, lines: 1, body: "x" },
        { pr_body: true, body: "y" },
      ],
    });
    expect(comments.map((c) => [c.final, c.prBody, c.lines])).toEqual([
      ["2", false, [1, 1]],
      [null, true, null],
    ]);
    const message = problemsOf({
      comments: [
        { body: "x", final: "" },
        { body: "x", pr_body: "yes" },
        { body: "x", final: "1", change: "k" },
        { body: "x", final: "1", pr_body: true },
      ],
    });
    expect(message).toContain("comments[0].final: must be a final commit's group id");
    expect(message).toContain("comments[1].pr_body: must be true or false");
    expect(message).toContain("comments[2]: final and pr_body comments stand alone");
    expect(message).toContain(
      "comments[3]: a comment is on a final commit or the PR body, not both",
    );
  });
});
