import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, ChangeSnapshot, CheckRun, Entry, Phase } from "../src/model.ts";
import { repoDir } from "../src/paths.ts";
import { Store } from "../src/store.ts";

const agent: Actor = { kind: "agent", name: "claude-code" };
const phases: Phase[] = [{ id: 1, title: "One", bookmark: "f/1-one", doneWhen: null, tasks: [] }];

const change = (id: string): ChangeSnapshot => ({
  changeId: id,
  commitId: `commit-${id}`,
  description: `Change ${id}\n\nPlan-Task: 1.1\n`,
  trailers: [["Plan-Task", "1.1"]],
  phaseId: 1,
  bookmarks: ["f/1-one"],
  conflicted: false,
  empty: false,
  stats: { files: 2, added: 10, removed: 3 },
});

const checkRun = (id: string, overrides: Partial<CheckRun> = {}): CheckRun => ({
  id,
  check: "test",
  command: "bun test",
  changeId: "a",
  commitId: "commit-a",
  trigger: "auto",
  status: "pass",
  exitCode: 0,
  logPath: `/logs/${id}.log`,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  ...overrides,
});

let home: string;
let store: Store;
const root = "/work/my-repo";

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "lr-store-"));
  process.env.LOCAL_REVIEW_HOME = home;
  store = await Store.open(root);
  store.createFeature({ slug: "f", title: "Feature", baseRevset: "trunk()" });
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const newRound = (changes = [change("a")], checkRunIds: string[] = []) =>
  store.createRound("f", {
    jjOpId: "op1",
    planVersion: 1,
    baseCommitId: "base",
    changes,
    checkRunIds,
    createdBy: agent,
  });

describe("Store", () => {
  test("records the repo root and reopens without re-migrating", async () => {
    const repoJson = await Bun.file(join(repoDir(root), "repo.json")).json();
    expect(repoJson.root).toBe(root);
    store.close();
    store = await Store.open(root);
    expect(store.getFeature("f")?.title).toBe("Feature");
  });

  test("features", () => {
    expect(() => store.createFeature({ slug: "f", title: "x", baseRevset: "x" })).toThrow(
      /already exists/,
    );
    expect(store.getFeature("missing")).toBeNull();
    store.createFeature({ slug: "g", title: "G", baseRevset: "main" });
    store.setFeatureStatus("g", "abandoned");
    expect(store.listFeatures().map((f) => [f.slug, f.status])).toEqual([
      ["f", "planning"],
      ["g", "abandoned"],
    ]);
  });

  test("plan versions count up and become current", () => {
    const v1 = store.addPlanVersion("f", { phases, respondsToRound: null, createdBy: agent });
    const v2 = store.addPlanVersion("f", { phases, respondsToRound: 1, createdBy: agent });
    expect([v1.version, v1.path, v2.version, v2.path]).toEqual([1, "plan/v1.md", 2, "plan/v2.md"]);
    expect(store.getFeature("f")?.currentPlanVersion).toBe(2);
    expect(store.getPlanVersion("f", 2)).toMatchObject({
      phases,
      respondsToRound: 1,
      createdBy: agent,
    });
    expect(store.getPlanVersion("f", 3)).toBeNull();
  });

  test("rounds round-trip their snapshot and put the feature in review", () => {
    expect(store.latestRound("f")).toBeNull();
    const { round, replaced } = newRound([change("a"), change("b")]);
    expect([round.n, round.status, replaced]).toEqual([1, "open", null]);
    expect(store.latestRound("f")).toEqual(round);
    expect(store.getFeature("f")?.status).toBe("in_review");
  });

  test("a new round supersedes an unreviewed round and closes a reviewed one", () => {
    newRound();
    const second = newRound();
    expect([second.round.n, second.replaced]).toEqual([2, { n: 1, status: "superseded" }]);

    store.submitReview("f", { round: 2, reviewer: agent, verdict: null, body: "hm", comments: [] });
    const third = newRound();
    expect(third.replaced).toEqual({ n: 2, status: "closed" });
    const statuses = store.db
      .query("SELECT n, status FROM rounds WHERE feature = 'f' ORDER BY n")
      .all();
    expect(statuses).toEqual([
      { n: 1, status: "superseded" },
      { n: 2, status: "closed" },
      { n: 3, status: "open" },
    ]);
  });

  test("a human verdict decides the round and hands the feature back", () => {
    newRound();
    const human: Actor = { kind: "human", name: "nick" };
    const review = (reviewer: Actor, verdict: "approved" | "changes_requested") =>
      store.submitReview("f", { round: 1, reviewer, verdict, body: null, comments: [] });

    review(agent, "approved");
    expect([store.latestRound("f")?.verdict, store.getFeature("f")?.status]).toEqual([
      null,
      "in_review",
    ]);
    review(human, "changes_requested");
    expect([store.latestRound("f")?.verdict, store.getFeature("f")?.status]).toEqual([
      "changes_requested",
      "revising",
    ]);
    review(human, "approved");
    expect([store.latestRound("f")?.verdict, store.getFeature("f")?.status]).toEqual([
      "approved",
      "finalizing",
    ]);
  });

  test("entries append to threads and apply status changes", () => {
    newRound();
    const { threads } = store.submitReview("f", {
      round: 1,
      reviewer: agent,
      verdict: null,
      body: null,
      comments: [
        {
          anchor: { kind: "feature" },
          severity: null,
          body: "a",
          suggestion: null,
          status: "open",
        },
      ],
    });
    const id = threads[0]!.id;
    const entry = (body: string, statusChange: Entry["statusChange"]) => ({
      id: Bun.randomUUIDv7(),
      author: agent,
      body,
      suggestion: null,
      statusChange,
      round: 1,
      createdAt: new Date().toISOString(),
    });
    store.addEntry("f", id, entry("fixed", { from: "open", to: "addressed" }));
    const thread = store.addEntry("f", id, entry("thanks", null));
    expect(thread.status).toBe("addressed");
    expect(thread.entries.map((e) => [e.body, e.statusChange])).toEqual([
      ["a", null],
      ["fixed", { from: "open", to: "addressed" }],
      ["thanks", null],
    ]);
    expect(store.getThread("f", 99)).toBeNull();
  });

  test("re-anchoring moves a thread's anchor and keeps the original", async () => {
    newRound();
    const feature = { kind: "feature" as const };
    const comment = { severity: null, body: "a", suggestion: null, status: "open" as const };
    store.submitReview("f", {
      round: 1,
      reviewer: agent,
      verdict: null,
      body: null,
      comments: [{ ...comment, anchor: feature }],
    });
    expect(store.getThread("f", 1)).toMatchObject({ anchorRound: 1, originalAnchor: feature });

    const moved = { kind: "phase" as const, phaseId: 1 };
    store.placeThreads("f", [{ id: 1, anchor: moved, anchorRound: 2, anchorState: "moved" }]);
    expect(store.getThread("f", 1)).toMatchObject({
      anchor: moved,
      anchorRound: 2,
      anchorState: "moved",
      originalAnchor: feature,
    });

    // Threads from before migration 3 get their original anchor and round backfilled.
    store.db.run("ALTER TABLE threads DROP COLUMN anchor_round");
    store.db.run("ALTER TABLE threads DROP COLUMN original_anchor");
    store.db.run("PRAGMA user_version = 2");
    store.close();
    store = await Store.open(root);
    expect(store.getThread("f", 1)).toMatchObject({ anchorRound: 1, originalAnchor: moved });
  });

  test("check runs: passing lookup, updates, and round links", () => {
    store.insertCheckRun("f", checkRun("fail1", { status: "fail", exitCode: 1 }));
    expect(store.findPassingCheck("f", "test", "bun test", "commit-a")).toBeNull();

    store.insertCheckRun("f", checkRun("run1", { status: "running", exitCode: null }));
    store.updateCheckRun("run1", { status: "pass", exitCode: 0 });
    expect(store.findPassingCheck("f", "test", "bun test", "commit-a")?.id).toBe("run1");
    expect(store.findPassingCheck("f", "test", "bun test --bail", "commit-a")).toBeNull();
    expect(store.findPassingCheck("f", "test", "bun test", "commit-b")).toBeNull();

    const { round } = newRound([change("a")], ["run1"]);
    expect(store.roundChecks("f", round.n).map((c) => [c.id, c.status])).toEqual([
      ["run1", "pass"],
    ]);
  });

  test("the database lives in the repo dir", () => {
    expect(existsSync(join(repoDir(root), "state.db"))).toBe(true);
  });
});
