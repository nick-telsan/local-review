import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { NoteOk } from "../src/commands/note.ts";
import type { ReviewCreateOk } from "../src/commands/review.ts";
import type { ReplyOk, ThreadsOk } from "../src/commands/thread.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson } from "./lr.ts";

const AUTHOR = ["--as", "agent:claude-code"];
const CODEX = ["--as", "agent:codex"];
const NICK = ["--as", "human:nick"];

// main: README.md
// c1 adds db.ts, c2 adds use.ts. No phase bookmarks yet: phase 1 is still being written.
let repo: TestRepo;
let c1: string, c2: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Add db", { "db.ts": "a\nb\nc\n" });
  c2 = await repo.commit("Use db", { "use.ts": "x\n" });
  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
});

afterEach(() => repo.cleanup());

async function note(...args: string[]): Promise<NoteOk["thread"]> {
  const r = await lrJson<NoteOk>(repo, "note", ...args, ...AUTHOR);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.data.thread;
}

const notes = async () => (await lrJson<ThreadsOk>(repo, "threads", "--notes")).data.threads;

/** Open a round with both changes in phase 1. */
async function openRound(): Promise<ReviewCreateOk> {
  await repo.bookmark("feat/1-schema");
  const r = await lrJson<ReviewCreateOk>(repo, "review", "create");
  expect(r.code).toBe(0);
  return r.data;
}

describe("lr note", () => {
  test("notes a change, or lines of its diff, before any bookmark exists", async () => {
    const onChange = await note(c1.slice(0, 4), "Split out so phase 2 can reuse it");
    expect(onChange).toMatchObject({
      id: 1,
      kind: "note",
      status: "resolved",
      anchor: { kind: "change", changeId: c1 },
      anchorRound: null,
      createdBy: { kind: "agent", name: "claude-code" },
      entries: [{ body: "Split out so phase 2 can reuse it" }],
    });
    expect(onChange.anchorStack!.changes.map((c) => c.changeId)).toEqual([c1, c2]);

    const onLines = await note(c1, "db.ts:2-3", "Temporary until phase 2");
    expect(onLines.anchor).toMatchObject({
      kind: "code",
      changeId: c1,
      path: "db.ts",
      side: "new",
      lines: [2, 3],
      snippet: ["b", "c"],
    });
    expect((await lr(repo, "note", c2, "use.ts:1", "-m", "Why", ...AUTHOR)).out).toBe(
      `Noted #3 on use.ts:1 @${c2.slice(0, 8)}`,
    );
  });

  test("--old notes lines the change removed", async () => {
    const c3 = await repo.commit("Trim db", { "db.ts": "a\n" });
    const t = await note(c3, "db.ts:3", "--old", "No caller left");
    expect(t.anchor).toMatchObject({ side: "old", lines: [3, 3], snippet: ["c"] });
  });

  test("bad input", async () => {
    const err = async (...args: string[]) => (await lr(repo, "note", ...args)).err;
    expect(await err()).toContain("usage: lr note <change>");
    expect(await err(c1)).toContain("a note needs text");
    expect(await err(c1, "db.ts:2")).toContain("a note needs text");
    expect(await err(c1, "--old", "why")).toContain("--old needs a location");
    expect(await err(c1, "db.ts", "why")).toContain("give the note's text as one quoted argument");
    expect(await err(c1, "why", "-m", "why")).toContain("give the note's text as one quoted");
    expect(await err(c1, "db.ts:3-2", "why")).toContain("lines must be 1-based, first ≤ last");
    expect(await err(c1, "db.ts:9", "why")).toContain("lines 9-9 are past the end of db.ts");
    expect(await err(c1, "use.ts:1", "why")).toContain("use.ts doesn't exist on the new side");
    expect(await err("zzzz", "why")).toContain(`change "zzzz" isn't in the stack`);
  });

  test("needs something in the stack", async () => {
    await repo.jj("new", "main");
    expect((await lr(repo, "note", c1, "why")).err).toContain(
      "stack is empty: the working copy is already in main",
    );
  });
});

describe("notes across rounds", () => {
  test("the next round places notes, following the lines they're on", async () => {
    await note(c1, "db.ts:2", "Kept for the migration");
    await note(c1, "db.ts:3", "Will change");
    // Amend c1: a new first line, and line 3 edited.
    await repo.write("db.ts", "top\na\nb\nC\n");
    await repo.jj("squash", "--into", c1, "db.ts");

    const round = await openRound();
    expect(round.reanchored).toMatchObject([
      { id: 1, anchorState: "moved", anchor: { lines: [3, 3] } },
      { id: 2, anchorState: "outdated" },
    ]);
    const [kept, changed] = await notes();
    expect(kept).toMatchObject({ status: "resolved", anchorRound: 1, anchor: { lines: [3, 3] } });
    // An outdated note keeps trying from the stack it was written on.
    expect(changed).toMatchObject({ anchorRound: null, anchor: { lines: [3, 3], snippet: ["c"] } });
  });

  test("a reply from someone else reopens a note for its author", async () => {
    await note(c1, "db.ts:3", "Will change");
    await repo.write("db.ts", "a\nb\nC\n");
    await repo.jj("squash", "--into", c1, "db.ts");
    await openRound();

    const own = await lrJson<ReplyOk>(repo, "reply", "1", "More context.", ...AUTHOR);
    expect(own.data.thread.status).toBe("resolved");
    const asked = await lrJson<ReplyOk>(repo, "reply", "1", "Change how?", ...NICK);
    expect(asked.data.thread.status).toBe("open");
    expect(asked.data.thread.entries.at(-1)!.statusChange).toEqual({
      from: "resolved",
      to: "open",
    });

    await lr(repo, "review", "submit", "--verdict", "changes_requested", ...NICK);
    const handoff = (await lr(repo, "handoff")).out;
    expect(handoff).toContain("#1 · your note · `db.ts:3` (new) · outdated");
    expect(handoff).toContain("_This changed after the note was written. As it was then:_");
    expect(handoff).toContain("**human:nick**");
  });

  test("whoever reopened a note reviews it", async () => {
    await note(c1, "Why");
    await openRound();
    expect((await lr(repo, "reply", "1", "--reopen", ...AUTHOR)).err).toContain(
      "only a human or someone other than the note's author can --reopen it",
    );
    await lr(repo, "reply", "1", "Why this way?", ...CODEX);
    await lr(repo, "reply", "1", "--addressed", "Explained in the message", ...AUTHOR);
    expect((await lr(repo, "reply", "1", "--resolve", "--as", "agent:other")).err).toContain(
      "only a human or the thread's reviewer (agent:codex) can --resolve it",
    );
    expect((await lr(repo, "reply", "1", "--resolve", ...CODEX)).code).toBe(0);
    expect((await lr(repo, "reply", "1", "--reopen", "--as", "agent:other")).err).toContain(
      "(agent:codex)",
    );
  });
});

describe("listing notes", () => {
  test("lr threads --notes, and lr status", async () => {
    expect((await lr(repo, "threads", "--notes")).out).toBe(
      "No proposed/open/addressed/resolved/dismissed notes.",
    );
    await note(c1, "db.ts:1", "First");
    await note(c2, "Second");
    await openRound();
    await lr(repo, "reply", "2", "Hm?", ...NICK);

    expect((await lr(repo, "threads")).out).toMatch(/^#2 +open +note +change /);
    const listed = (await lr(repo, "threads", "--notes")).out.split("\n");
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatch(/^#1 +resolved +note +db\.ts:1 @\w{8} +First$/);
    expect(
      (await lrJson<ThreadsOk>(repo, "threads", "--notes", "--status", "open")).data.threads,
    ).toHaveLength(1);

    const status = (await lr(repo, "status")).out;
    expect(status).toContain("Threads: 1 open\n");
    expect(status).toContain("Notes: 2 (`lr threads --notes`)");
  });
});
