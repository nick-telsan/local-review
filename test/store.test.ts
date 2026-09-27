import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, ChangeSnapshot, CheckRun, Phase } from "../src/model.ts";
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
    const { round, superseded } = newRound([change("a"), change("b")]);
    expect([round.n, round.status, superseded]).toEqual([1, "open", null]);
    expect(store.latestRound("f")).toEqual(round);
    expect(store.getFeature("f")?.status).toBe("in_review");
  });

  test("a new round supersedes the open one", () => {
    newRound();
    const { round, superseded } = newRound();
    expect([round.n, superseded]).toEqual([2, 1]);
    const statuses = store.db
      .query("SELECT n, status FROM rounds WHERE feature = 'f' ORDER BY n")
      .all();
    expect(statuses).toEqual([
      { n: 1, status: "superseded" },
      { n: 2, status: "open" },
    ]);
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
