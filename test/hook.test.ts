import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { humanClaim } from "../src/commands/hook.ts";
import { repoDir } from "../src/paths.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrWithStdin } from "./lr.ts";

let repo: TestRepo;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
});

afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_OPTION_STOP_REMINDER;
  repo.cleanup();
});

const runHook = (event: string, input: Record<string, unknown> = {}) =>
  lrWithStdin(repo, JSON.stringify({ cwd: repo.root, session_id: "s1", ...input }), "hook", event);

async function startFeature(slug = "feat"): Promise<void> {
  await lr(repo, "feature", "start", slug, "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"), "--feature", slug);
}

describe("lr hook session-start", () => {
  test("stays silent outside jj repos and repos lr hasn't been used in", async () => {
    const outside = await runHook("session-start", { cwd: repo.tmp });
    expect([outside.code, outside.out]).toEqual([0, ""]);
    const unused = await runHook("session-start");
    expect([unused.code, unused.out]).toEqual([0, ""]);
    // Checking must not create lr state for the repo.
    expect(existsSync(repoDir(repo.root))).toBe(false);
  });

  test("describes the active feature and what's next", async () => {
    await startFeature();
    await repo.commit("Add table", { "schema.sql": "create table t;\n" });
    await repo.bookmark("feat/1-schema");
    await lr(repo, "review", "create");
    const review = JSON.stringify({ comments: [{ body: "hm" }] });
    await lrWithStdin(repo, review, "review", "submit", "-F", "-", "--as", "agent:codex");
    const r = await runHook("session-start");
    expect(r.out).toBe(
      [
        'local-review (lr) is tracking feature "feat" in this repo: in_review, plan v1, round 1 (open).',
        "Threads: 1 open.",
        "Next: agent reviewers requested changes: read `lr handoff`.",
        "Use the lr-author skill to plan, implement, or revise, and the lr-review skill to review a round.",
      ].join("\n"),
    );
  });

  test("lists features when there are several", async () => {
    await lr(repo, "feature", "start", "feat", "--base", "main");
    expect((await runHook("session-start")).out).toContain(
      '"feat" in this repo: planning, no plan yet.\nNext: write a plan',
    );
    await startFeature("other");
    const r = await runHook("session-start");
    expect(r.out).toContain(
      "tracking 2 features in this repo: feat (planning), other (implementing).",
    );
    expect(r.out).toContain("need `--feature <slug>`");
  });

  test("says nothing once every feature is done", async () => {
    await lr(repo, "feature", "start", "feat", "--base", "main");
    await lr(repo, "feature", "start", "other", "--base", "main");
    const { Store } = await import("../src/store.ts");
    const store = await Store.open(repo.root);
    store.setFeatureStatus("feat", "done");
    store.setFeatureStatus("other", "abandoned");
    store.close();
    expect((await runHook("session-start")).out).toBe("");
  });
});

describe("lr hook pre-tool-use", () => {
  test("asks before an lr command claims to be a human", async () => {
    const r = await runHook("pre-tool-use", {
      tool_name: "Bash",
      tool_input: { command: "lr review submit --verdict approved --as human:nick" },
    });
    expect(JSON.parse(r.out)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
    });
    expect(r.out).toContain("This runs lr as human:nick.");
  });

  test("lets agents and other tools through", async () => {
    for (const input of [
      { tool_name: "Bash", tool_input: { command: "lr reply 3 --resolve --as agent:codex" } },
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { tool_name: "Edit", tool_input: {} },
    ]) {
      expect((await runHook("pre-tool-use", input)).out).toBe("");
    }
  });

  test("humanClaim reads --as and LR_ACTOR", () => {
    expect(humanClaim("LR_ACTOR=nick lr reply 3 --resolve")).toBe("human:nick");
    expect(humanClaim("lr reply 3 --resolve --as='human:sam'")).toBe("human:sam");
    expect(humanClaim("cd x && lr status --as agent:a")).toBeNull();
    // --as only matters on an lr command.
    expect(humanClaim("other --as nick")).toBeNull();
  });
});

describe("lr hook stop", () => {
  beforeEach(async () => {
    await startFeature();
    // The session starts before any work, then commits a change.
    await runHook("session-start");
    await repo.commit("Add table", { "schema.sql": "create table t;\n" });
    await repo.bookmark("feat/1-schema");
  });

  test("reminds once per stack state after the session changed the stack", async () => {
    const first = await runHook("stop");
    expect(first.code).toBe(2);
    expect(first.err).toContain('"feat" has changes but no review round yet');
    expect((await runHook("stop")).code).toBe(0);
    await repo.commit("More", { "more.sql": "x\n" });
    expect((await runHook("stop")).code).toBe(2);
  });

  test("leaves alone sessions that didn't change the stack", async () => {
    await runHook("session-start", { session_id: "s2" });
    expect((await runHook("stop", { session_id: "s2" })).code).toBe(0);
    // Without a record of how a session started (hooks installed mid-session), it stays quiet.
    expect((await runHook("stop", { session_id: "s3" })).code).toBe(0);
  });

  test("never blocks twice in a row, and can be turned off", async () => {
    expect((await runHook("stop", { stop_hook_active: true })).code).toBe(0);
    process.env.CLAUDE_PLUGIN_OPTION_STOP_REMINDER = "false";
    expect((await runHook("stop")).code).toBe(0);
  });

  test("stays quiet in review, and while revising until the stack changes", async () => {
    await lr(repo, "review", "create");
    expect((await runHook("stop")).code).toBe(0);
    await lr(repo, "review", "submit", "--verdict", "changes_requested", "--as", "human:nick");
    expect((await runHook("stop")).code).toBe(0);
    await repo.write("schema.sql", "create table t (id int);\n");
    await repo.jj("squash", "--into", "feat/1-schema");
    const r = await runHook("stop");
    expect(r.code).toBe(2);
    expect(r.err).toContain('the "feat" stack has changed since round 1');
  });

  test("skips stacks lr can't read", async () => {
    await repo.jj("new", "main");
    await repo.commit("Sideways", { "side.txt": "x\n" });
    await repo.jj("new", "feat/1-schema", "@-", "-m", "Merge");
    expect((await runHook("stop")).code).toBe(0);
  });
});

test("unknown hook events are a usage error", async () => {
  const r = await lrWithStdin(repo, "{}", "hook", "nope");
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: lr hook session-start|pre-tool-use|stop");
});
