import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { FinalApplyOk, FinalCutOk, FinalShowOk } from "../src/commands/final.ts";
import type { ReviewCreateOk } from "../src/commands/review.ts";
import type { ThreadsOk } from "../src/commands/thread.ts";
import type { Handoff } from "../src/handoff.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson, lrWithStdin } from "./lr.ts";

const NICK = ["--as", "human:nick"];
const CODEX = ["--as", "agent:codex"];

// main: README.md
// phase 1 (feat/1-schema): c1 adds schema.sql, c2 adds backfill.sql
// phase 2 (feat/2-rotation): c3 adds rotate.ts
let repo: TestRepo;
let c1: string, c2: string, c3: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Add table", { "schema.sql": "create table t;\n" });
  c2 = await repo.commit("Backfill", { "backfill.sql": "insert;\n" });
  await repo.bookmark("feat/1-schema");
  c3 = await repo.commit("Rotate", { "rotate.ts": "export {};\n" });
  await repo.bookmark("feat/2-rotation");

  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
  await lr(repo, "review", "create");
});

afterEach(() => repo.cleanup());

const approve = (...args: string[]) =>
  lr(repo, "review", "submit", "--verdict", "approved", ...NICK, ...args);
const draft = (group: string, text: string) =>
  lrWithStdin(repo, text, "final", "message", group, "-F", "-");
const prBody = (text: string) => lrWithStdin(repo, text, "final", "pr-body", "-F", "-");
const show = async () => (await lrJson<FinalShowOk>(repo, "final", "show")).data;
const submit = (review: unknown, ...as: string[]) =>
  lrWithStdin(repo, JSON.stringify(review), "review", "submit", "-F", "-", ...as);

async function draftAll(): Promise<void> {
  expect((await draft("1", "Add the token table\n\nWith a backfill.")).code).toBe(0);
  expect((await draft("2", "Rotate tokens on use")).code).toBe(0);
  expect((await prBody("## Summary\n\nToken rotation.\n\n## Testing\n\nbun test")).code).toBe(0);
}

async function finalRound(): Promise<ReviewCreateOk> {
  const r = await lrJson<ReviewCreateOk>(repo, "review", "create", "--final");
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.data;
}

test("finalization waits for a human to approve the code", async () => {
  expect((await lr(repo, "final", "show")).err).toContain(
    'feature "feat" is in_review; finalization starts once a human approves a round',
  );
  await approve();
  expect((await lr(repo, "status")).out).toContain("draft the final commits (`lr final show`)");
});

describe("drafting", () => {
  beforeEach(async () => {
    await approve();
  });

  test("one final commit per phase, with the drafts' state", async () => {
    const s = await show();
    expect(s.round).toBe(1);
    expect(s.groups.map((g) => [g.id, g.bookmark, g.changes.map((c) => c.changeId)])).toEqual([
      ["1", "feat/1-schema", [c1, c2]],
      ["2", "feat/2-rotation", [c3]],
    ]);
    expect([s.groups[0]!.message, s.prBody, s.commitGuidelines, s.prTemplate]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const text = (await lr(repo, "final", "show")).out;
    expect(text).toContain("  1    Schema (feat/1-schema)\n");
    expect(text).toContain(`         ${c2.slice(0, 8)}  Backfill\n`);
    expect(text).toContain("message: not drafted (lr final message 1 -F <file>)");
    expect(text).toContain("PR body: not drafted (lr final pr-body -F <file>)");
  });

  test("messages and the PR body are files", async () => {
    expect((await draft("1", "  \n")).err).toContain("the message for 1 is empty");
    const long = `${"A".repeat(80)}\nno blank line`;
    const saved = await draft("1", long);
    expect(saved.out).toContain("Saved the message for final commit 1");
    expect(saved.out).toContain("warning: the subject is 80 characters (over 72)");
    expect(saved.out).toContain("warning: the subject isn't followed by a blank line");
    expect((await prBody("  Body\n\n")).out).toContain("Saved the PR body");

    const s = await show();
    expect(s.groups[0]!.message).toBe(long);
    expect(await Bun.file(s.groups[0]!.messagePath).text()).toBe(`${long}\n`);
    expect([s.prBody, await Bun.file(s.prBodyPath).text()]).toEqual(["Body", "Body\n"]);
    const text = (await lr(repo, "final", "show")).out;
    expect(text).toContain(`message: ${"A".repeat(80)}`);
    expect(text).toContain("PR body: Body");
  });

  test("bad input", async () => {
    expect((await draft("9", "x")).err).toContain('no final commit "9" (groups: 1, 2)');
    expect((await lr(repo, "final", "message", "1")).err).toContain("usage: lr final message");
    expect((await lr(repo, "final", "pr-body")).err).toContain("usage: lr final pr-body");
    expect((await prBody(" ")).err).toContain("the PR body is empty");
    expect((await lr(repo, "final", "cut")).err).toContain("usage: lr final cut");
  });

  test("guidelines and the PR template come from the repo", async () => {
    await repo.write(".github/pull_request_template.md", "## Summary\n");
    await repo.write("docs/commits.md", "Imperative subjects.\n");
    await repo.write(".local-review.toml", '[final]\ncommit_guidelines = "docs/commits.md"\n');
    const s = await show();
    expect(s.commitGuidelines).toEqual({ path: "docs/commits.md", text: "Imperative subjects.\n" });
    expect(s.prTemplate).toEqual({
      path: ".github/pull_request_template.md",
      text: "## Summary\n",
    });
    const text = (await lr(repo, "final", "show")).out;
    expect(text).toContain("Commit guidelines: docs/commits.md\nPR template: .github/");
  });

  test("a cut splits a phase and clears its drafted message", async () => {
    await draft("1", "Phase one");
    await draft("2", "Phase two");
    const cut = await lrJson<FinalCutOk>(repo, "final", "cut", c2.slice(0, 6));
    expect(cut.data).toEqual({
      phaseId: 1,
      groups: [
        { id: "1a", changeIds: [c1] },
        { id: "1b", changeIds: [c2] },
      ],
      cleared: ["1"],
    });
    expect((await show()).groups.map((g) => [g.id, g.message])).toEqual([
      ["1a", null],
      ["1b", null],
      ["2", "Phase two"],
    ]);
    expect((await lr(repo, "final", "cut", c2)).err).toContain("already a cut");
    expect((await lr(repo, "final", "cut", c1)).err).toContain("first change of phase 1");

    await draft("1a", "First half");
    const undo = await lr(repo, "final", "cut", c2, "--remove");
    expect(undo.out).toBe(
      "Phase 1 is now 1 final commit: 1 (2 changes)\nCleared drafted messages for 1a; draft them again.",
    );
    expect((await lr(repo, "final", "cut", c2, "--remove")).err).toContain("no cut at");
  });

  test("every change needs a phase", async () => {
    await repo.commit("Stray", { "stray.txt": "x\n" });
    await lr(repo, "review", "create");
    await approve();
    expect((await lr(repo, "final", "show")).err).toContain(
      "every change needs a phase before finalizing",
    );
  });
});

describe("lr review create --final", () => {
  beforeEach(async () => {
    await approve();
  });

  test("needs every draft, settled threads, and the approved stack", async () => {
    expect((await lr(repo, "review", "create", "--final")).err).toContain(
      "draft these first: message 1, message 2, the PR body",
    );
    await draftAll();
    await submit({ comments: [{ body: "one more thing" }] }, ...CODEX);
    expect((await lr(repo, "review", "create", "--final")).err).toContain(
      "settle these threads first: #1 (open)",
    );
    await lr(repo, "reply", "1", "--dismiss", ...NICK);
    expect((await lr(repo, "review", "create", "--final", "--skip-checks")).err).toContain(
      "--final reuses the approved round's checks",
    );

    await repo.write("rotate.ts", "export const x = 1;\n");
    await repo.jj("squash", "--into", c3);
    expect((await lr(repo, "review", "create", "--final")).err).toContain(
      "the stack changed since round 1 was approved",
    );
  });

  test("freezes the groups, messages, and PR body for review", async () => {
    await draftAll();
    await submit({ comments: [{ body: "nit" }] }, ...CODEX);
    await lr(repo, "reply", "1", "--addressed", "done");
    const text = await lr(repo, "review", "create", "--final");
    expect(text.out).toBe(
      [
        "Final round 2 opened for feat: 3 changes from round 1 → 2 commits",
        "  round 1 is now closed",
        "  1    Add the token table  (2 changes)",
        "  2    Rotate tokens on use  (1 change)",
        "PR body: ## Summary",
        "Threads: 1 current",
        "warning: #1 marked addressed, still waiting on their reviewers",
      ].join("\n"),
    );
    const { data } = await lrJson<{ round: { kind: string; final: unknown } }>(repo, "status");
    expect(data.round).toMatchObject({
      kind: "final",
      final: {
        approvedRound: 1,
        groups: [
          {
            id: "1",
            phaseId: 1,
            changeIds: [c1, c2],
            message: "Add the token table\n\nWith a backfill.",
          },
          { id: "2", phaseId: 2, changeIds: [c3], message: "Rotate tokens on use" },
        ],
      },
    });
    expect((await lr(repo, "status")).out).toContain("Status: final_review");
  });
});

describe("final review", () => {
  beforeEach(async () => {
    await approve();
    await draftAll();
  });

  test("final and pr_body comments need a final round", async () => {
    const r = await submit({ comments: [{ final: 1, body: "x" }] }, ...CODEX);
    expect(r.err).toContain("round 1 reviews code; final and pr_body comments need a final round");
  });

  test("the loop: comment, redraft, re-anchor, approve", async () => {
    await finalRound();
    const bad = await submit({ comments: [{ final: "3", body: "x" }] }, ...CODEX);
    expect(bad.err).toContain('no final commit "3" in round 2 (groups: 1, 2)');
    const r = await submit(
      {
        verdict: "changes_requested",
        comments: [
          {
            final: 1,
            lines: 1,
            severity: "nit",
            body: "Say which table.",
            suggestion: "Add the refresh_tokens table",
          },
          { pr_body: true, lines: [5, 5], body: "Explain the reuse check." },
          { pr_body: true, body: "Shorter, please." },
        ],
      },
      ...CODEX,
    );
    expect(r.out).toContain("#1 nit        final 1:1");
    expect(r.out).toContain("#2            PR body:5");
    expect(r.out).toContain("#3            PR body");

    const handoff = await lr(repo, "handoff");
    expect(handoff.out).toContain("# Review handoff: feat, final round 2");
    expect(handoff.out).toContain(
      "## Final commit messages\n\n### #1 · nit · final commit 1, line 1\n\n```\nAdd the token table\n```",
    );
    expect(handoff.out).toContain("## PR body\n\n### #2 · PR body, line 5");
    expect(handoff.out).toContain("### #3 · PR body\n\n> **agent:codex**: Shorter, please.");
    expect(handoff.out).toContain("1. Edit the drafts the threads are on");
    expect(handoff.out).toContain("3. Run `lr review create --final`");

    // The author redrafts: the message's first line changes, and the PR body gains a line on top.
    await draft("1", "Add the refresh_tokens table\n\nWith a backfill.");
    await prBody("Intro.\n## Summary\n\nToken rotation.\n\n## Testing\n\nbun test");
    for (const id of ["1", "2", "3"]) await lr(repo, "reply", id, "--addressed", "Redrafted");
    const next = await finalRound();
    expect(next.reanchored.map((t) => [t.id, t.anchorState])).toEqual([
      [1, "outdated"],
      [2, "moved"],
      [3, "outdated"],
    ]);
    expect(next.reanchored[1]!.anchor).toMatchObject({ kind: "pr_body", lines: [6, 6] });

    // The developer edits a draft after the round opened: approving now would skip that edit.
    for (const id of ["1", "2", "3"]) await lr(repo, "reply", id, "--resolve", ...CODEX);
    await prBody("## Summary\n\nToken rotation, reviewed.");
    expect((await approve()).err).toContain(
      "the drafts changed since final round 3 opened (PR body); run `lr review create --final`",
    );
    await finalRound();
    expect((await approve()).code).toBe(0);
    expect((await lr(repo, "status")).out).toContain(
      "Status: approved\nPlan: v1\nRound 4 (open, plan v1)",
    );
    expect((await lrJson<Handoff>(repo, "handoff")).data.nextSteps).toEqual([
      "The final commits are approved. Run `lr final apply` to squash the stack.",
    ]);
  });

  test("final threads wait out a code round", async () => {
    await finalRound();
    await submit({ comments: [{ final: "2", body: "Hmm." }] }, ...CODEX);
    await lr(repo, "review", "create");
    const { data } = await lrJson<ThreadsOk>(repo, "threads");
    expect(data.threads[0]).toMatchObject({ anchorRound: 2, anchorState: "current" });
  });
});

describe("lr final apply", () => {
  beforeEach(async () => {
    await approve();
    await draftAll();
  });

  test("needs an approved final round", async () => {
    expect((await lr(repo, "final", "apply")).err).toContain(
      'nothing to apply: "feat" is finalizing',
    );
    await finalRound();
    expect((await lr(repo, "final", "apply")).err).toContain("is final_review");
  });

  test("squashes each group into its last change, as approved", async () => {
    await finalRound();
    await approve();
    const oldTree = await repo.jj("file", "list", "-r", c3);

    const r = await lrJson<FinalApplyOk>(repo, "final", "apply");
    expect(r.err).toBe("");
    expect(r.data.commits.map((c) => [c.groupId, c.changeId, c.bookmarks, c.subject])).toEqual([
      ["1", c2, ["feat/1-schema"], "Add the token table"],
      ["2", c3, ["feat/2-rotation"], "Rotate tokens on use"],
    ]);
    expect(r.data.prBody).toStartWith("## Summary");

    const log = await repo.jj(
      "log",
      "--no-graph",
      "-r",
      "main..feat/2-rotation",
      "-T",
      'description ++ "--\\n"',
    );
    expect(log).toBe("Rotate tokens on use\n--\nAdd the token table\n\nWith a backfill.\n--\n");
    expect(await repo.jj("file", "list", "-r", c3)).toBe(oldTree);
    expect((await lr(repo, "status", "--feature", "feat")).out).toContain("Status: done");

    // The undo point puts the stack back.
    await repo.jj("op", "restore", r.data.opBefore);
    expect(
      await repo.jj(
        "log",
        "--no-graph",
        "-r",
        "main..feat/2-rotation",
        "-T",
        'description.first_line() ++ "\\n"',
      ),
    ).toBe("Rotate\nBackfill\nAdd table\n");
  });

  test("prints what to do next", async () => {
    await finalRound();
    await approve();
    const r = await lr(repo, "final", "apply");
    expect(r.out).toContain("Applied final round 2: 3 changes → 2 commits");
    expect(r.out).toContain("Next: push the stack (e.g. `jj git push -b feat/2-rotation`)");
  });

  test("refuses edits made after the approval", async () => {
    await finalRound();
    await approve();
    await draft("2", "Rotate tokens on every use");
    expect((await lr(repo, "final", "apply")).err).toContain(
      "the drafts changed since round 2 was approved (message 2)",
    );
  });

  test("refuses a stack or threads that changed after the approval", async () => {
    await finalRound();
    await approve();
    await submit({ comments: [{ body: "wait" }] }, ...CODEX);
    expect((await lr(repo, "final", "apply")).err).toContain("settle these threads first: #1");
    await lr(repo, "reply", "1", "--dismiss", ...NICK);
    await repo.write("rotate.ts", "export const y = 2;\n");
    await repo.jj("squash", "--into", c3);
    expect((await lr(repo, "final", "apply")).err).toContain(
      "the stack changed since final round 2",
    );
  });

  test("puts the repo back when a squash fails", async () => {
    await finalRound();
    await approve();
    const stack = () => repo.jj("log", "--no-graph", "-r", "main::", "-T", 'commit_id ++ "\\n"');
    const before = await stack();
    // jj refuses to rewrite immutable commits, so the first squash fails.
    await repo.jj(
      "config",
      "set",
      "--repo",
      'revset-aliases."immutable_heads()"',
      `builtin_immutable_heads() | ${c1}`,
    );
    const r = await lr(repo, "final", "apply");
    expect(r.code).toBe(1);
    expect(r.err).toContain("final apply failed, so the repo was restored to operation");
    expect(await stack()).toBe(before);
    expect((await lr(repo, "status")).out).toContain("Status: approved");
  });
});
