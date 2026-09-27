import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkTargets, runChecks } from "../src/checks.ts";
import type { CheckConfig, RepoConfig } from "../src/config.ts";
import { Jj } from "../src/jj.ts";
import type { ChangeSnapshot } from "../src/model.ts";
import { parsePlan } from "../src/plan.ts";
import { takeSnapshot } from "../src/snapshot.ts";
import { Store } from "../src/store.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";

const { phases } = parsePlan(TWO_PHASE_PLAN, "feat");

const change = (id: string, bookmarks: string[] = [], empty = false): ChangeSnapshot => ({
  changeId: id,
  commitId: `commit-${id}`,
  description: id,
  trailers: [],
  phaseId: null,
  bookmarks,
  conflicted: false,
  empty,
  stats: { files: 0, added: 0, removed: 0 },
});

const check = (name: string, at: CheckConfig["at"]): CheckConfig => ({
  name,
  run: "true",
  at,
  timeoutMs: 1000,
});

describe("checkTargets", () => {
  const changes = [
    change("a"),
    change("b", ["feat/1-schema", "unrelated"]),
    change("c", [], true),
    change("d", ["feat/2-rotation"]),
  ];
  const targets = (c: CheckConfig) =>
    checkTargets([c], changes, phases).map((t) => t.change.changeId);

  test("tip is the last change", () => {
    expect(targets(check("x", "tip"))).toEqual(["d"]);
  });

  test("bookmarks are changes carrying a phase bookmark", () => {
    expect(targets(check("x", "bookmarks"))).toEqual(["b", "d"]);
  });

  test("changes are all non-empty changes", () => {
    expect(targets(check("x", "changes"))).toEqual(["a", "b", "d"]);
  });

  test("targets are ordered by stack position, then check", () => {
    const pairs = checkTargets([check("t", "tip"), check("b", "bookmarks")], changes, phases).map(
      (t) => `${t.check.name}@${t.change.changeId}`,
    );
    expect(pairs).toEqual(["b@b", "t@d", "b@d"]);
  });
});

describe("runChecks", () => {
  let repo: TestRepo;
  let store: Store;

  beforeEach(async () => {
    repo = await TestRepo.create();
    await repo.commit("base", { "README.md": "hello\n" });
    await repo.bookmark("main");
    await repo.commit("Add table", { "schema.sql": "good\n" });
    await repo.bookmark("feat/1-schema");
    await repo.commit("Rotate", { "rotate.ts": "x\n" });
    await repo.bookmark("feat/2-rotation");
    store = await Store.open(repo.root);
    store.createFeature({ slug: "feat", title: "Feat", baseRevset: "main" });
  });

  afterEach(() => {
    store.close();
    repo.cleanup();
  });

  const run = async (config: RepoConfig) => {
    const jj = new Jj(repo.root);
    const snap = await takeSnapshot(jj, "main", phases);
    const featureDir = join(repo.tmp, "feature");
    const results = await runChecks({
      jj,
      store,
      slug: "feat",
      featureDir,
      config,
      targets: checkTargets(config.checks, snap.changes, phases),
      trigger: "auto",
      log: () => {},
    });
    return { results, featureDir };
  };

  test("runs in a separate workspace and reuses passing results", async () => {
    const config: RepoConfig = {
      setup: "touch setup-ran",
      checks: [
        {
          name: "has-schema",
          run: "test -f schema.sql && touch dirty",
          at: "bookmarks",
          timeoutMs: 5000,
        },
      ],
    };
    const first = await run(config);
    expect(first.results.map((r) => [r.run.status, r.cached])).toEqual([
      ["pass", false],
      ["pass", false],
    ]);
    // Neither the check's nor setup's files leak into the developer's working copy or history.
    expect(existsSync(join(repo.root, "dirty"))).toBe(false);
    expect(existsSync(join(first.featureDir, "workspaces", "checks", "dirty"))).toBe(false);
    const files = await repo.jj("log", "--no-graph", "-r", "all()", "-T", "self.diff().summary()");
    expect(files).not.toContain("dirty");
    expect(files).not.toContain("setup-ran");

    const second = await run(config);
    expect(second.results.map((r) => [r.run.id, r.cached])).toEqual(
      first.results.map((r) => [r.run.id, true]),
    );
  });

  test("a changed command isn't served from cache", async () => {
    const pass = (run: string): RepoConfig => ({
      setup: null,
      checks: [{ name: "c", run, at: "tip", timeoutMs: 5000 }],
    });
    await run(pass("true"));
    const again = await run(pass("true "));
    expect(again.results.map((r) => r.cached)).toEqual([false]);
  });

  test("recreates the workspace if its directory was deleted", async () => {
    const config: RepoConfig = {
      setup: null,
      checks: [{ name: "c", run: "exit 1", at: "tip", timeoutMs: 5000 }],
    };
    const { featureDir } = await run(config);
    await Bun.$`rm -rf ${join(featureDir, "workspaces")}`;
    const again = await run(config);
    expect(again.results.map((r) => r.run.status)).toEqual(["fail"]);
  });
});
