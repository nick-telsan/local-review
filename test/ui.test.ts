import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ReviewSubmitOk } from "../src/commands/submit.ts";
import type { ReplyOk } from "../src/commands/thread.ts";
import type { UiOk } from "../src/commands/ui.ts";
import { Context } from "../src/context.ts";
import { repoDir } from "../src/paths.ts";
import type { ChangeView, FeaturesOk, ReviewDraft, RoundView } from "../src/ui/api.ts";
import { POLL_MS, startUi, type UiServer } from "../src/ui/server.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr } from "./lr.ts";

// main: README.md
// c1 (phase 1, feat/1-schema): adds db.ts
// c2 (phase 2, feat/2-rotation): adds rotate.ts
let repo: TestRepo;
let ctx: Context;
let server: UiServer;
let c1: string, c2: string;

const silent = { out: () => {}, err: () => {}, stdin: async () => "" };

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  c1 = await repo.commit("Add db\n\nWith a body.", { "db.ts": "a\nb\nc\n" });
  await repo.bookmark("feat/1-schema");
  c2 = await repo.commit("Rotate", { "rotate.ts": "r1\nr2\n" });
  await repo.bookmark("feat/2-rotation");
  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
  expect((await lr(repo, "review", "create")).code).toBe(0);
  ctx = (await Context.create({ repo: repo.root }, silent)).with({
    actor: { kind: "human", name: "nick" },
  });
  server = startUi(ctx);
});

afterEach(async () => {
  await server.stop();
  ctx.close();
  repo.cleanup();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(`/api${path}`, server.url), {
    ...init,
    headers: { authorization: `Bearer ${server.token}`, ...init.headers },
  });
}

async function json<T>(path: string): Promise<T> {
  const res = await api(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

function placements(view: RoundView) {
  return Object.fromEntries(view.threads.map((t) => [t.entries[0]!.body, t.placement]));
}

async function review(comments: object[], verdict = "changes_requested"): Promise<void> {
  const file = join(repo.tmp, "review.json");
  await Bun.write(file, JSON.stringify({ verdict, body: "See comments.", comments }));
  const r = await lr(repo, "review", "submit", "-F", file, "--as", "human:nick");
  expect(r.err).toBe("");
}

describe("security", () => {
  test("the API needs the token", async () => {
    const none = await fetch(new URL("/api/features", server.url));
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: string }).error).toContain("lr ui");
    expect((await api("/features", { headers: { authorization: "Bearer nope" } })).status).toBe(
      401,
    );
    expect((await api("/features")).status).toBe(200);
  });

  test("only the event stream takes the token in the URL", async () => {
    const q = `?t=${server.token}`;
    expect((await fetch(new URL(`/api/features${q}`, server.url))).status).toBe(401);
    const events = await fetch(new URL(`/api/events${q}`, server.url));
    expect(events.status).toBe(200);
    await events.body?.cancel();
  });

  test("refuses another Host (DNS rebinding) and writes from another origin", async () => {
    expect((await api("/features", { headers: { host: "evil.example" } })).status).toBe(403);
    const localhost = await api("/features", { headers: { host: `localhost:${server.port}` } });
    expect(localhost.status).toBe(200);
    const post = { method: "POST", headers: { origin: "https://evil.example" } };
    expect((await api("/ping", post)).status).toBe(403);
    const same = { method: "POST", headers: { origin: `http://127.0.0.1:${server.port}` } };
    expect((await api("/ping", same)).status).toBe(200);
  });

  test("the page itself is public, and every path serves it", async () => {
    for (const path of ["/", "/f/feat/r/1"]) {
      const res = await fetch(new URL(path, server.url));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
    }
  });
});

describe("the API", () => {
  test("lists features with their latest round and unsettled threads", async () => {
    await review([{ body: "General." }]);
    const data = await json<FeaturesOk>("/features");
    expect(data.root).toBe(repo.root);
    expect(data.actor).toEqual({ kind: "human", name: "nick" });
    expect(data.features).toEqual([
      {
        slug: "feat",
        title: "feat",
        status: "revising",
        latestRound: expect.objectContaining({ n: 1, kind: "code", status: "open" }),
        unsettled: 1,
      },
    ]);
  });

  test("a round, with each thread placed where it shows", async () => {
    await review([
      { body: "General." },
      { phase: 2, body: "Phase-wide." },
      { change: c1, body: "On the change." },
      { change: c1, message: true, body: "Message." },
      { change: c1, path: "db.ts", lines: [2, 2], body: "Inline." },
      { phase: 1, path: "db.ts", lines: [1, 1], body: "In the phase diff." },
    ]);
    const view = await json<RoundView>("/features/feat/rounds/latest");
    expect(view.round.n).toBe(1);
    expect(view.latest).toBe(true);
    expect(view.phases.map((p) => p.id)).toEqual([1, 2]);
    expect(view.rounds).toHaveLength(1);
    expect(view.reviews).toHaveLength(1);
    expect(placements(view)).toEqual({
      "General.": { on: "feature" },
      "Phase-wide.": { on: "phase", phaseId: 2 },
      "On the change.": { on: "change", changeId: c1 },
      "Message.": { on: "message", changeId: c1, lines: null },
      "Inline.": { on: "line", changeId: c1, path: "db.ts", side: "new", lines: [2, 2] },
      // Phase 1 is only c1, but its diff is still the phase's, not the change's.
      "In the phase diff.": { on: "line", changeId: c1, path: "db.ts", side: "new", lines: [1, 1] },
    });
  });

  test("a comment made in a multi-change diff is listed with its change, not inline", async () => {
    await review([{ path: "db.ts", lines: [1, 1], body: "Stack-wide." }]);
    const view = await json<RoundView>("/features/feat/rounds/1");
    expect(view.threads[0]!.placement).toEqual({ on: "aside", changeId: c1 });
  });

  test("an earlier round shows the threads made in it, where they were made", async () => {
    await review([
      { change: c1, path: "db.ts", lines: [2, 2], body: "Round 1." },
      { change: c2, body: "On c2." },
    ]);
    await repo.write("db.ts", "a\nB\nc\n");
    await repo.jj("squash", "--into", c1, "db.ts");
    await repo.jj("abandon", c2);
    expect((await lr(repo, "review", "create")).code).toBe(0);
    await review([{ change: c1, body: "Round 2." }]);

    const first = await json<RoundView>("/features/feat/rounds/1");
    expect(first.latest).toBe(false);
    expect(placements(first)).toEqual({
      "Round 1.": { on: "line", changeId: c1, path: "db.ts", side: "new", lines: [2, 2] },
      "On c2.": { on: "change", changeId: c2 },
    });
    expect(first.threads[0]!.anchorState).toBe("current");

    // In round 2, the line has changed and c2 is gone, but both threads still need settling.
    const second = await json<RoundView>("/features/feat/rounds/2");
    expect(second.rounds.map((r) => r.n)).toEqual([1, 2]);
    expect(placements(second)).toEqual({
      "Round 1.": { on: "aside", changeId: c1 },
      "On c2.": { on: "gone" },
      "Round 2.": { on: "change", changeId: c1 },
    });

    // Settling an outdated thread keeps it in the round where that happened.
    await lr(repo, "reply", "1", "--resolve", "--as", "human:nick");
    const settled = await json<RoundView>("/features/feat/rounds/2");
    expect(settled.threads.find((t) => t.id === 1)).toMatchObject({
      status: "resolved",
      placement: { on: "aside", changeId: c1 },
    });
  });

  test("a change's files, from the round's cached patch or else from jj", async () => {
    const view = await json<ChangeView>(`/features/feat/rounds/1/changes/${c1}`);
    expect(view.changeId).toBe(c1);
    expect(view.files).toEqual([
      expect.objectContaining({ status: "added", newPath: "db.ts", added: 3, removed: 0 }),
    ]);

    rmSync(join(repoDir(repo.root), "feat", "rounds", "1", "patches", `${c1}.patch`));
    const again = await json<ChangeView>(`/features/feat/rounds/1/changes/${c1}`);
    expect(again.files).toEqual(view.files);
  });

  test("errors come back as JSON", async () => {
    const cases = [
      ["/features/nope/rounds/latest", 400, 'no feature "nope"'],
      ["/features/feat/rounds/9", 400, "no round 9"],
      ["/features/feat/rounds/1/changes/zzzz", 400, "round 1 has no change zzzz"],
      ["/nothing", 404, "not found"],
    ] as const;
    for (const [path, status, message] of cases) {
      const res = await api(path);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toContain(message);
    }
  });
});

async function send<T>(method: string, path: string, data?: unknown) {
  const res = await api(path, {
    method,
    headers: { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: res.status, data: (await res.json()) as T & { error?: string } };
}

describe("drafting a review", () => {
  const draftPath = "/features/feat/rounds/1/draft";

  test("comments collect in a draft only its author sees, then submit as one review", async () => {
    const added = await send<ReviewDraft>("POST", `${draftPath}/comments`, {
      change: c1,
      path: "db.ts",
      lines: [2, 3],
      severity: "blocking",
      body: "NOT NULL.",
      suggestion: "B\nC",
    });
    expect(added.status).toBe(200);
    const [first] = added.data.comments;
    expect(first!.placement).toEqual({
      on: "line",
      changeId: c1,
      path: "db.ts",
      side: "new",
      lines: [2, 3],
    });
    await send("POST", `${draftPath}/comments`, { change: c1, message: true, body: "Subject?" });
    await send("PUT", draftPath, { verdict: "changes_requested", body: "Close." });

    const view = await json<RoundView>("/features/feat/rounds/1");
    expect(view.draft).toMatchObject({ verdict: "changes_requested", body: "Close." });
    expect(view.draft!.comments.map((c) => c.placement.on)).toEqual(["line", "message"]);
    // Nobody else sees it: not the CLI, not another person's view.
    expect((await lr(repo, "threads")).out).toBe("No proposed/open/addressed threads.");
    const other = ctx.with({ actor: { kind: "human", name: "sam" } });
    const { roundView } = await import("../src/ui/api.ts");
    expect(roundView(other, "feat", "1").draft).toBeNull();

    const edited = await send<ReviewDraft>("PUT", `${draftPath}/comments/${first!.id}`, {
      change: c1,
      path: "db.ts",
      lines: [2, 2],
      body: "Just this one.",
    });
    expect(edited.data.comments[0]).toMatchObject({
      id: first!.id,
      comment: { change: c1, path: "db.ts", lines: [2, 2], body: "Just this one." },
    });

    const submitted = await send<ReviewSubmitOk>("POST", `${draftPath}/submit`, {
      verdict: "changes_requested",
      body: "Close.",
    });
    expect(submitted.status).toBe(200);
    expect(submitted.data.review).toMatchObject({
      reviewer: { kind: "human", name: "nick" },
      verdict: "changes_requested",
      body: "Close.",
    });
    expect(submitted.data.threads.map((t) => t.entries[0]!.body)).toEqual([
      "Just this one.",
      "Subject?",
    ]);
    const after = await json<RoundView>("/features/feat/rounds/1");
    expect(after.draft).toBeNull();
    expect(after.threads.map((t) => t.actions)).toEqual([
      ["addressed", "resolve", "dismiss"],
      ["addressed", "resolve", "dismiss"],
    ]);
  });

  test("a comment is checked when it's added, the way lr review submit checks it", async () => {
    const bad = await send("POST", `${draftPath}/comments`, {
      change: c1,
      path: "nope.ts",
      lines: [1, 1],
      body: "x",
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("nope.ts");
    const shape = await send("POST", `${draftPath}/comments`, { change: c1, lines: [1, 1] });
    expect(shape.data.error).toContain("body: required");
    const missing = await send("DELETE", `${draftPath}/comments/nope`);
    expect(missing.data.error).toContain("no draft comment nope");
  });

  test("deleting comments, discarding, and an empty submit", async () => {
    const { data } = await send<ReviewDraft>("POST", `${draftPath}/comments`, { body: "Hm." });
    const deleted = await send<ReviewDraft>(
      "DELETE",
      `${draftPath}/comments/${data.comments[0]!.id}`,
    );
    expect(deleted.data.comments).toEqual([]);
    const empty = await send("POST", `${draftPath}/submit`, { verdict: null, body: "" });
    expect(empty.data.error).toContain("review is empty");

    await send("POST", `${draftPath}/comments`, { body: "Again." });
    expect((await send<{ ok: true }>("DELETE", draftPath)).data).toEqual({ ok: true });
    expect((await json<RoundView>("/features/feat/rounds/1")).draft).toBeNull();
  });

  test("a draft on a round that's since superseded can't be submitted, only discarded", async () => {
    await send("POST", `${draftPath}/comments`, { body: "Old." });
    await repo.write("db.ts", "a\nB\nc\n");
    await repo.jj("squash", "--into", c1, "db.ts");
    expect((await lr(repo, "review", "create")).code).toBe(0);

    expect((await json<RoundView>("/features/feat/rounds/2")).otherDrafts).toEqual([1]);
    const late = await send("POST", `${draftPath}/submit`, { verdict: null, body: null });
    expect(late.data.error).toContain("round 1 was superseded; review round 2 instead");
    expect((await send("DELETE", draftPath)).status).toBe(200);
    expect((await json<RoundView>("/features/feat/rounds/2")).otherDrafts).toEqual([]);
  });

  test("bodies must be JSON", async () => {
    const res = await api(`${draftPath}/comments`, { method: "POST", body: "{" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("must be JSON");
  });
});

describe("replying", () => {
  test("replies and status changes follow lr reply's rules", async () => {
    await review([{ change: c1, body: "Why?" }]);
    const path = "/features/feat/threads/1/replies";
    const replied = await send<ReplyOk>("POST", path, { body: "Asking again." });
    expect(replied.data.thread.entries.at(-1)).toMatchObject({ body: "Asking again." });
    const resolved = await send<ReplyOk>("POST", path, { action: "resolve" });
    expect(resolved.data.thread.status).toBe("resolved");
    expect((await json<RoundView>("/features/feat/rounds/1")).threads[0]!.actions).toEqual([
      "reopen",
    ]);
    const wrong = await send("POST", path, { action: "accept" });
    expect(wrong.data.error).toContain("#1 is resolved");
    expect((await send("POST", "/features/feat/threads/x/replies", {})).data.error).toContain(
      "no thread #x",
    );
  });

  test("an agent only gets the actions lr reply would allow it", async () => {
    await review([{ change: c1, body: "Why?" }]);
    const { allowedActions } = await import("../src/commands/thread.ts");
    const thread = ctx.store.getThread("feat", 1)!;
    expect(allowedActions({ kind: "agent", name: "codex" }, thread)).toEqual(["addressed"]);
    expect(allowedActions({ kind: "human", name: "nick" }, thread)).toEqual([
      "addressed",
      "resolve",
      "dismiss",
    ]);
  });
});

describe("live updates", () => {
  test("the event stream says so when another process changes lr's state", async () => {
    const res = await fetch(new URL(`/api/events?t=${server.token}`, server.url));
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toContain(": connected");

    // The CLI opens its own connection to the database, like an agent's lr would.
    await review([{ body: "New." }]);
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(POLL_MS * 4).then(() => ({ value: "timed out" })),
    ]);
    expect(next.value).toBe("data: changed\n\n");
    await reader.cancel();
  });
});

describe("lr ui", () => {
  const info = () => join(repoDir(repo.root), "ui.json");

  /** Run `lr ui` in-process until `stop` resolves, with its output. */
  async function runUi(...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const { main } = await import("../src/cli.ts");
    const done = main(["ui", "--no-open", "-R", repo.root, ...args], {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      stdin: async () => "",
    });
    return { out, err, done };
  }

  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
    expect(check()).toBe(true);
  }

  test("serves until Ctrl-C, and a second one reuses it", async () => {
    const first = await runUi("--json");
    await waitFor(() => first.out.length > 0);
    const ok = JSON.parse(first.out[0]!) as UiOk;
    expect(ok.reused).toBe(false);
    expect(ok.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/f\/feat\?t=/);
    expect(existsSync(info())).toBe(true);

    const token = new URL(ok.url).searchParams.get("t")!;
    const res = await fetch(new URL("/api/features", ok.url), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await res.json()) as FeaturesOk).actor.kind).toBe("human");

    const second = await runUi();
    expect(await second.done).toBe(0);
    expect(second.out.join("\n")).toContain(`already running: ${ok.url}`);

    process.emit("SIGINT", "SIGINT");
    expect(await first.done).toBe(0);
    expect(existsSync(info())).toBe(false);
  });

  test("needs a recent Bun", async () => {
    const { ui } = await import("../src/commands/ui.ts");
    await expect(ui(ctx, { open: false, bunVersion: "1.3.14" })).rejects.toThrow(
      "the UI needs Bun 1.4.2 or later, and this is 1.3.14",
    );
  });

  test("starts afresh over a stale or unreadable record of another UI", async () => {
    // A live pid (this one) with nothing serving its port, then a record that isn't JSON.
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = closed.port!;
    await closed.stop();
    for (const record of [JSON.stringify({ pid: process.pid, port, token: "x" }), "{"]) {
      await Bun.write(info(), record);
      const run = await runUi("--json");
      await waitFor(() => run.out.length > 0);
      expect((JSON.parse(run.out[0]!) as UiOk).reused).toBe(false);
      process.emit("SIGINT", "SIGINT");
      expect(await run.done).toBe(0);
    }
  });

  test("opens the link with $BROWSER", async () => {
    const log = join(repo.tmp, "opened");
    const browser = join(repo.tmp, "browser.sh");
    await Bun.write(browser, `#!/bin/sh\necho "$1" > ${log}\n`);
    chmodSync(browser, 0o755);
    process.env.BROWSER = browser;
    try {
      const { ui } = await import("../src/commands/ui.ts");
      const out: string[] = [];
      const done = ui(ctx.with({ json: true, io: { ...silent, out: (t) => out.push(t) } }), {
        open: true,
      });
      await waitFor(() => existsSync(log));
      const { url } = JSON.parse(out[0]!) as UiOk;
      await waitFor(() => readFileSync(log, "utf8").trim() === url);
      process.emit("SIGINT", "SIGINT");
      expect(await done).toBe(0);
    } finally {
      delete process.env.BROWSER;
    }
  });

  test("acts as a person, never as an agent", async () => {
    const r = await lr(repo, "ui", "--no-open", "--as", "agent:claude-code");
    expect(r.code).toBe(1);
    expect(r.err).toContain("the UI acts for a person, not agent:claude-code");
  });

  test("rejects a bad port, and says when it's taken", async () => {
    expect((await lr(repo, "ui", "--no-open", "--port", "http")).err).toContain(
      '--port must be a port number, not "http"',
    );
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = other.port!;
    const taken = await lr(repo, "ui", "--no-open", "--port", String(port));
    await other.stop();
    expect(taken.code).toBe(1);
    expect(taken.err).toContain(`port ${port} is in use`);
  });

  test("lands on the feature list when there's no one active feature", async () => {
    await lr(repo, "feature", "start", "other", "--base", "main");
    const run = await runUi("--json");
    await waitFor(() => run.out.length > 0);
    expect((JSON.parse(run.out[0]!) as UiOk).url).toMatch(/:\d+\/\?t=/);
    process.emit("SIGTERM", "SIGTERM");
    expect(await run.done).toBe(0);
  });
});
