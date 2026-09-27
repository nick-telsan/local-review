import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ReviewSubmitOk } from "../src/commands/submit.ts";
import type { Review, Round, Thread } from "../src/model.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson, lrWithStdin } from "./lr.ts";

type StatusJson = { round: Round; reviews: Review[]; threads: Thread[] };

let repo: TestRepo;
let c1: string, c3: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Add table", { "schema.sql": "create table t (\n  id int\n);\n" });
  await repo.commit("Backfill", { "backfill.sql": "insert;\n" });
  await repo.bookmark("feat/1-schema");
  c3 = await repo.commit("Rotate on use", { "rotate.ts": "export {};\n" });
  await repo.bookmark("feat/2-rotation");

  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
});

afterEach(() => repo.cleanup());

const writeReview = async (review: unknown) => {
  const path = join(repo.tmp, `review-${Bun.randomUUIDv7()}.json`);
  await Bun.write(path, JSON.stringify(review));
  return path;
};

const submit = async (review: unknown, ...args: string[]) =>
  lrJson<ReviewSubmitOk>(repo, "review", "submit", "-F", await writeReview(review), ...args);

const status = async () => (await lrJson<StatusJson>(repo, "status")).data;

describe("lr review submit", () => {
  beforeEach(async () => {
    expect((await lr(repo, "review", "create")).code).toBe(0);
  });

  test("records a review with one thread per comment", async () => {
    const r = await submit(
      {
        verdict: "changes_requested",
        body: "Mostly good.",
        comments: [
          { body: "Feature-flag this." },
          {
            change: c1.slice(0, 6),
            path: "schema.sql",
            lines: 2,
            severity: "blocking",
            body: "NOT NULL",
            suggestion: "  id int not null",
          },
          { change: c3, message: true, severity: "nit", body: "Imperative subject" },
        ],
      },
      "--as",
      "agent:codex",
    );
    expect(r.code).toBe(0);
    expect(r.data.review).toMatchObject({
      round: 1,
      reviewer: { kind: "agent", name: "codex" },
      state: "submitted",
      verdict: "changes_requested",
      body: "Mostly good.",
    });
    expect(r.data.threads.map((t) => [t.id, t.anchor.kind, t.status, t.severity])).toEqual([
      [1, "feature", "open", null],
      [2, "code", "open", "blocking"],
      [3, "message", "open", "nit"],
    ]);
    expect(r.data.threads[1]!.entries).toMatchObject([
      {
        author: { kind: "agent", name: "codex" },
        body: "NOT NULL",
        suggestion: "  id int not null",
        round: 1,
      },
    ]);
    expect(r.data.threads[1]!.anchor).toMatchObject({ changeId: c1, snippet: ["  id int"] });

    // An agent's verdict doesn't decide the round.
    const s = await status();
    expect(s.round.verdict).toBeNull();
    expect(s.threads).toHaveLength(3);
  });

  test("a human's verdict becomes the round's verdict", async () => {
    const r = await lrJson<ReviewSubmitOk>(
      repo,
      "review",
      "submit",
      "--verdict",
      "approved",
      "-m",
      "LGTM",
      "--as",
      "human:nick",
    );
    expect(r.code).toBe(0);
    expect(r.data.threads).toEqual([]);
    expect((await status()).round.verdict).toBe("approved");
  });

  test("flags override the file", async () => {
    const r = await submit(
      { verdict: "approved", body: "from file" },
      "--verdict",
      "changes_requested",
      "-m",
      "from flag",
    );
    expect(r.data.review).toMatchObject({ verdict: "changes_requested", body: "from flag" });
  });

  test("thread ids continue across reviews", async () => {
    await submit({ comments: [{ body: "one" }] });
    const r = await submit({ comments: [{ body: "two" }, { body: "three" }] });
    expect(r.data.threads.map((t) => t.id)).toEqual([2, 3]);
  });

  test("agent comments await triage when configured", async () => {
    await repo.write(".local-review.toml", "[review]\ntriage_agent_comments = true\n");
    const agent = await submit({ comments: [{ body: "hmm" }] }, "--as", "agent:codex");
    expect(agent.data.threads[0]!.status).toBe("proposed");
    const human = await submit({ comments: [{ body: "hmm" }] }, "--as", "human:nick");
    expect(human.data.threads[0]!.status).toBe("open");

    const text = await lr(
      repo,
      "review",
      "submit",
      "-F",
      await writeReview({ comments: [{ body: "x" }] }),
      "--as",
      "agent:codex",
    );
    expect(text.out).toContain("1 comment(s) await triage");
  });

  test("nothing is recorded unless every location resolves", async () => {
    const r = await lr(
      repo,
      "review",
      "submit",
      "-F",
      await writeReview({
        verdict: "changes_requested",
        comments: [
          { body: "fine" },
          { change: "zzzzzzzz", body: "unknown change" },
          { path: "schema.sql", lines: 99, body: "past the end" },
        ],
      }),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("review not recorded");
    expect(r.err).toContain('comments[1]: change "zzzzzzzz" isn\'t in round 1');
    expect(r.err).toContain("comments[2]: lines 99-99 are past the end of schema.sql");
    const s = await status();
    expect([s.reviews.length, s.threads.length]).toEqual([0, 0]);
  });

  test("status summarizes reviews and threads", async () => {
    await submit(
      { verdict: "changes_requested", comments: [{ body: "a" }, { body: "b" }] },
      "--as",
      "agent:codex",
    );
    const r = await lr(repo, "status");
    expect(r.out).toMatch(/Reviews:\n\s+agent:codex\s+changes_requested\s+2 comment\(s\)/);
    expect(r.out).toContain("Threads: 2 open");
  });

  test("text output lists the new threads", async () => {
    const r = await lr(
      repo,
      "review",
      "submit",
      "-F",
      await writeReview({
        verdict: "changes_requested",
        comments: [
          { change: c1, path: "schema.sql", lines: [1, 2], severity: "blocking", body: "x" },
        ],
      }),
      "--as",
      "agent:codex",
    );
    expect(r.out).toContain("Review recorded on round 1 by agent:codex: changes requested");
    expect(r.out).toMatch(new RegExp(`#1 blocking\\s+schema.sql:1-2 @${c1.slice(0, 8)}`));
  });

  test("rounds: superseded, missing, and malformed", async () => {
    await lr(repo, "review", "create");
    const old = await lr(repo, "review", "submit", "--verdict", "approved", "--round", "1");
    expect(old.err).toContain("round 1 was superseded; review round 2 instead");
    expect(
      (await lr(repo, "review", "submit", "--verdict", "approved", "--round", "7")).err,
    ).toContain("no round 7 (latest is 2)");
    expect(
      (await lr(repo, "review", "submit", "--verdict", "approved", "--round", "x")).err,
    ).toContain("no round x");
    expect((await lr(repo, "review", "submit", "--verdict", "approved", "--round", "2")).code).toBe(
      0,
    );
  });

  test("closed rounds can't be reviewed", async () => {
    const { Store } = await import("../src/store.ts");
    const store = await Store.open(repo.root);
    store.db.query("UPDATE rounds SET status = 'closed'").run();
    store.close();
    expect((await lr(repo, "review", "submit", "--verdict", "approved")).err).toContain(
      "round 1 is closed",
    );
  });

  test("input errors", async () => {
    expect((await lr(repo, "review", "submit")).err).toContain("usage: lr review submit");
    expect((await lr(repo, "review", "submit", "-F", "/no/such.json")).err).toContain(
      "no such file",
    );
    const bad = join(repo.tmp, "bad.json");
    await Bun.write(bad, "{ not json");
    expect((await lr(repo, "review", "submit", "-F", bad)).err).toContain("is not valid JSON");
    expect((await lr(repo, "review", "submit", "--verdict", "lgtm")).err).toContain(
      "verdict: must be",
    );
  });
});

test("submitting before any round", async () => {
  const r = await lr(repo, "review", "submit", "--verdict", "approved");
  expect(r.code).toBe(1);
  expect(r.err).toContain("no review round yet");
});

test("reads the review from stdin with -F -", async () => {
  await lr(repo, "review", "create");
  const review = JSON.stringify({ verdict: "approved", comments: [{ body: "nice" }] });
  const r = await lrWithStdin(repo, review, "review", "submit", "-F", "-", "--json");
  expect(r.code).toBe(0);
  expect((JSON.parse(r.out) as ReviewSubmitOk).threads).toHaveLength(1);
  const bad = await lrWithStdin(repo, "{", "review", "submit", "-F", "-");
  expect(bad.err).toContain("stdin is not valid JSON");
});
