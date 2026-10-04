import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ReplyOk, ThreadsOk } from "../src/commands/thread.ts";
import type { Handoff } from "../src/handoff.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson, lrWithStdin } from "./lr.ts";

let repo: TestRepo;
let c1: string;

const CODEX = ["--as", "agent:codex"];
const AUTHOR = ["--as", "agent:claude-code"];
const NICK = ["--as", "human:nick"];

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Adds table\n\nWith a body.", { "schema.sql": "create table t;\n" });
  await repo.bookmark("feat/1-schema");
  await repo.commit("Rotate", { "rotate.ts": "export {};\n" });
  await repo.bookmark("feat/2-rotation");

  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"), ...AUTHOR);
  await lr(repo, "review", "create", ...AUTHOR);
});

afterEach(() => repo.cleanup());

/** Submit a review from the given reviewer; returns the new thread ids. */
async function review(as: string[], data: unknown): Promise<number[]> {
  const path = join(repo.tmp, `review-${Bun.randomUUIDv7()}.json`);
  await Bun.write(path, JSON.stringify(data));
  const r = await lrJson<{ threads: { id: number }[] }>(
    repo,
    "review",
    "submit",
    "-F",
    path,
    ...as,
  );
  expect(r.code).toBe(0);
  return r.data.threads.map((t) => t.id);
}

describe("lr handoff", () => {
  test("isn't ready until someone reviews", async () => {
    const text = await lr(repo, "handoff");
    expect(text.code).toBe(1);
    expect(text.err).toContain("nothing to hand off: round 1 has no reviews yet");
    const json = await lrJson<{ ready: boolean; reason: string }>(repo, "handoff");
    expect([json.code, json.data]).toEqual([
      1,
      { ready: false, reason: "round 1 has no reviews yet" },
    ]);
  });

  test("renders open threads as markdown for the author", async () => {
    await review(CODEX, {
      verdict: "changes_requested",
      body: "One thing.",
      comments: [
        { change: c1, path: "schema.sql", lines: 1, severity: "blocking", body: "Add columns." },
        { change: c1, message: true, lines: [1, 3], severity: "nit", body: "Imperative." },
      ],
    });
    const r = await lr(repo, "handoff");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "**Verdict:** changes requested (by agent reviewers; no human verdict yet)",
    );
    expect(r.out).toContain("## Phase 1: Schema (`feat/1-schema`)");
    expect(r.out).toContain(`### Change \`${c1.slice(0, 8)}\` "Adds table"`);
    expect(r.out).toContain(
      "#### #2 · nit · commit message, lines 1-3\n\n```\nAdds table\n\nWith a body.\n```",
    );
    expect(r.out).toContain(
      "#### #1 · blocking · `schema.sql:1` (new)\n\n```sql\n1 | create table t;\n```",
    );

    const json = await lrJson<Handoff & { ready: true }>(repo, "handoff", "--round", "1");
    expect(json.data).toMatchObject({
      ready: true,
      round: 1,
      verdict: "changes_requested",
      decidedBy: "agents",
    });
    expect(json.data.threads.map((t) => t.id)).toEqual([2, 1]);
  });

  test("status points the author at the handoff", async () => {
    expect((await lr(repo, "status")).out).toContain("Next: waiting on reviews");
    await review(CODEX, { comments: [{ body: "hm" }] });
    expect((await lr(repo, "status")).out).toContain(
      "Next: agent reviewers requested changes: read `lr handoff`",
    );
    await lr(repo, "review", "submit", "--verdict", "approved", ...NICK);
    expect((await lr(repo, "status")).out).toContain("Status: finalizing");
  });

  test("a reviewed round is closed by the next one, and handoff can still read it", async () => {
    await review(CODEX, { verdict: "changes_requested", comments: [{ body: "x" }] });
    const next = await lrJson<{ replaced: unknown }>(repo, "review", "create");
    expect(next.data.replaced).toEqual({ n: 1, status: "closed" });
    expect((await lr(repo, "handoff", "--round", "1")).code).toBe(0);
    expect(
      (await lr(repo, "review", "submit", "--verdict", "approved", "--round", "1")).err,
    ).toContain("round 1 is closed");
  });
});

describe("lr reply", () => {
  let ids: number[];
  beforeEach(async () => {
    ids = await review(CODEX, {
      verdict: "changes_requested",
      comments: [{ body: "a" }, { body: "b" }],
    });
  });

  test("the author addresses; the reviewer resolves or reopens", async () => {
    const [a, b] = ids as [number, number];
    const addressed = await lrJson<ReplyOk>(
      repo,
      "reply",
      `#${a}`,
      "--addressed",
      "Fixed",
      "it",
      ...AUTHOR,
    );
    expect(addressed.data.thread).toMatchObject({ id: a, status: "addressed" });
    expect(addressed.data.thread.entries.at(-1)).toMatchObject({
      author: { kind: "agent", name: "claude-code" },
      body: "Fixed it",
      statusChange: { from: "open", to: "addressed" },
      round: 1,
    });

    expect((await lr(repo, "reply", String(a), "--reopen", "-m", "Not yet", ...CODEX)).out).toBe(
      `#${a}: addressed → open`,
    );
    expect((await lr(repo, "reply", String(a), "--resolve", ...NICK)).out).toBe(
      `#${a}: open → resolved`,
    );
    expect((await lr(repo, "reply", String(b), "Why?", ...AUTHOR)).out).toBe(
      `Replied to #${b} (open)`,
    );
    expect((await lr(repo, "reply", String(b), "--dismiss", ...CODEX)).out).toBe(
      `#${b}: open → dismissed`,
    );
  });

  test("the author can't resolve, dismiss, or reopen", async () => {
    for (const action of ["--resolve", "--dismiss"]) {
      const r = await lr(repo, "reply", String(ids[0]), action, ...AUTHOR);
      expect(r.code).toBe(1);
      expect(r.err).toContain("only a human or the thread's reviewer (agent:codex)");
    }
  });

  test("only humans accept proposed comments", async () => {
    await repo.write(".local-review.toml", "[review]\ntriage_agent_comments = true\n");
    const [p] = (await review(CODEX, { comments: [{ body: "maybe" }] })) as [number];
    expect((await lr(repo, "reply", String(p), "--accept", ...CODEX)).err).toContain(
      "only a human can --accept",
    );
    expect((await lr(repo, "reply", String(p), "--accept", ...NICK)).out).toBe(
      `#${p}: proposed → open`,
    );
  });

  test("transitions must make sense", async () => {
    expect((await lr(repo, "reply", String(ids[0]), "--accept", ...NICK)).err).toContain(
      "--accept applies to proposed threads",
    );
    await lr(repo, "reply", String(ids[0]), "--addressed", "done", ...AUTHOR);
    expect(
      (await lr(repo, "reply", String(ids[0]), "--addressed", "again", ...AUTHOR)).err,
    ).toContain("--addressed applies to open threads");
    await lr(repo, "reply", String(ids[0]), "--reopen", ...NICK);
    const r = await lr(repo, "reply", String(ids[0]), "--reopen", ...NICK);
    expect(r.err).toContain(
      `#${ids[0]} is open; --reopen applies to addressed, resolved, or dismissed threads`,
    );
  });

  test("the message can come from a file or stdin", async () => {
    const [a, b] = ids as [number, number];
    const text = 'Moved it to `lr ui`\'s "Yours" list.\n\nSee kxqp.\n';
    const r = await lrWithStdin(
      repo,
      text,
      "reply",
      String(a),
      "--addressed",
      "-F",
      "-",
      ...AUTHOR,
    );
    expect(r.out).toBe(`#${a}: open → addressed`);
    await Bun.write(join(repo.tmp, "reply.md"), "Why not?\n");
    await lr(repo, "reply", String(b), "-F", join(repo.tmp, "reply.md"), ...AUTHOR);
    const threads = (await lrJson<ThreadsOk>(repo, "threads", "--all")).data.threads;
    expect(threads.map((t) => t.entries.at(-1)!.body)).toEqual([
      'Moved it to `lr ui`\'s "Yours" list.\n\nSee kxqp.',
      "Why not?",
    ]);
    expect((await lr(repo, "reply", String(b), "x", "-F", "-", ...AUTHOR)).err).toContain(
      "give the message as an argument or with -F, not both",
    );
    expect((await lr(repo, "reply", String(b), "-F", "nope.md", ...AUTHOR)).err).toContain(
      "no such file: nope.md",
    );
  });

  test("messages are required for replies and --addressed", async () => {
    expect((await lr(repo, "reply", String(ids[0]), ...AUTHOR)).err).toContain(
      "a reply needs a message",
    );
    expect((await lr(repo, "reply", String(ids[0]), "--addressed", ...AUTHOR)).err).toContain(
      "--addressed needs a message",
    );
  });

  test("bad input", async () => {
    expect((await lr(repo, "reply")).err).toContain("usage: lr reply <thread>");
    expect((await lr(repo, "reply", "twelve", "x")).err).toContain("usage: lr reply <thread>");
    expect((await lr(repo, "reply", "99", "x")).err).toContain("no thread #99 in feat");
    expect((await lr(repo, "reply", "1", "--resolve", "--dismiss", ...NICK)).err).toContain(
      "pick one of --resolve, --dismiss",
    );
  });
});

describe("lr threads", () => {
  test("lists unsettled threads by default", async () => {
    expect((await lr(repo, "threads")).out).toBe("No proposed/open/addressed threads.");
    await review(CODEX, {
      comments: [
        {
          change: c1,
          path: "schema.sql",
          lines: 1,
          severity: "blocking",
          body: "A very long first line that goes well past the sixty character limit\nsecond",
        },
        { body: "general" },
      ],
    });
    await lr(repo, "reply", "2", "--dismiss", ...NICK);
    await lr(repo, "reply", "1", "--addressed", "done", ...AUTHOR);
    await lr(repo, "reply", "1", "thanks", ...CODEX);

    const r = await lr(repo, "threads");
    expect(r.out).toBe(
      `#1    addressed  blocking   schema.sql:1 @${c1.slice(0, 8)}  A very long first line that goes well past the sixty charac…  (+2 replies)`,
    );
    const all = await lrJson<ThreadsOk>(repo, "threads", "--all");
    expect(all.data.threads.map((t) => [t.id, t.status])).toEqual([
      [1, "addressed"],
      [2, "dismissed"],
    ]);
    const dismissed = await lr(repo, "threads", "--status", "dismissed, resolved");
    expect(dismissed.out).toMatch(/^#2\s+dismissed\s+general {2}general {2}\(\+1 reply\)$/);
    expect((await lr(repo, "threads", "--status", "done")).err).toContain("unknown status done");
  });
});
