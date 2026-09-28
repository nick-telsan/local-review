import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FeatureAbandonOk, FeatureCleanOk } from "../src/commands/feature.ts";
import { featureDir } from "../src/paths.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson, lrWithStdin } from "./lr.ts";

const NICK = ["--as", "human:nick"];
const AGENT = ["--as", "agent:claude-code"];

// main: README.md and a check, so rounds create a checks workspace
// phase 1 (feat/1-schema): c1; phase 2 (feat/2-rotation): c2
let repo: TestRepo;
let c1: string, c2: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", {
    "README.md": "hello\n",
    ".local-review.toml": '[[checks]]\nname = "ok"\nrun = "true"\n',
  });
  await repo.bookmark("main");
  c1 = await repo.commit("Add table", { "schema.sql": "create table t;\n" });
  await repo.bookmark("feat/1-schema");
  c2 = await repo.commit("Rotate", { "rotate.ts": "export {};\n" });
  await repo.bookmark("feat/2-rotation");
  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
});

afterEach(() => repo.cleanup());

const bookmarks = async () =>
  (await repo.jj("bookmark", "list", "-T", 'name ++ "\\n"')).trim().split("\n");
const workspaces = async () =>
  (await repo.jj("workspace", "list", "-T", 'name ++ "\\n"')).trim().split("\n");
const checksDir = () => join(featureDir(repo.root, "feat"), "workspaces");

async function clean(...args: string[]): Promise<FeatureCleanOk> {
  const r = await lrJson<FeatureCleanOk>(repo, "feature", "clean", ...args);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.data;
}

/** Take the feature through review and finalization to done. */
async function finish(): Promise<void> {
  await lr(repo, "review", "create");
  await lr(repo, "review", "submit", "--verdict", "approved", ...NICK);
  await lrWithStdin(repo, "Add the table", "final", "message", "1", "-F", "-");
  await lrWithStdin(repo, "Rotate", "final", "message", "2", "-F", "-");
  await lrWithStdin(repo, "## Summary", "final", "pr-body", "-F", "-");
  await lr(repo, "review", "create", "--final");
  await lr(repo, "review", "submit", "--verdict", "approved", ...NICK);
  expect((await lr(repo, "final", "apply")).code).toBe(0);
}

describe("lr feature abandon", () => {
  test("a human abandons a feature", async () => {
    expect((await lr(repo, "feature", "abandon", ...AGENT)).err).toContain(
      "only a human can abandon a feature",
    );
    const r = await lrJson<FeatureAbandonOk>(repo, "feature", "abandon", ...NICK);
    expect(r.data.feature.status).toBe("abandoned");
    expect((await lr(repo, "feature", "abandon", "feat", ...NICK)).err).toContain(
      'feature "feat" is already abandoned',
    );
    expect((await lr(repo, "feature", "abandon", "nope", ...NICK)).err).toContain(
      'no feature "nope" in this repo',
    );
    expect((await lr(repo, "status")).err).toContain(
      "no active feature; start one with `lr feature start <slug>`, or pick a finished one with " +
        "--feature: feat (abandoned)",
    );
  });

  test("prints what to do next", async () => {
    expect((await lr(repo, "feature", "abandon", ...NICK)).out).toContain(
      "Next: `lr feature clean feat` forgets its bookmarks and check workspace.",
    );
  });
});

describe("lr feature clean", () => {
  test("after the final apply: forgets the bookmarks and the checks workspace", async () => {
    await finish();
    expect(await bookmarks()).toEqual(["feat/1-schema", "feat/2-rotation", "main"]);
    expect(await workspaces()).toContain("lr-feat-checks");

    const r = await clean();
    expect(r.features).toEqual([
      {
        slug: "feat",
        forgotten: ["feat/1-schema", "feat/2-rotation"],
        kept: [],
        workspace: true,
        purged: false,
      },
    ]);
    expect(r.opBefore).toMatch(/^[0-9a-f]+$/);
    expect(await bookmarks()).toEqual(["main"]);
    expect(await workspaces()).toEqual(["default"]);
    expect(existsSync(checksDir())).toBe(false);
    // The commits and the review history stay.
    expect((await repo.jj("log", "--no-graph", "-r", c2, "-T", "description")).trim()).toBe(
      "Rotate",
    );
    expect((await lr(repo, "status", "--feature", "feat")).out).toContain("Status: done");

    const again = await lr(repo, "feature", "clean");
    expect(again.out).toBe(
      "feat: nothing to clean\nReview history is kept (`--purge` deletes it).",
    );
  });

  test("prints the undo point", async () => {
    await finish();
    const r = await lr(repo, "feature", "clean", "feat");
    expect(r.out).toContain(
      "feat: forgot feat/1-schema, feat/2-rotation; removed its checks workspace",
    );
    expect(r.out).toMatch(/Undo the jj changes with `jj op restore [0-9a-f]{12}`\./);
  });

  test("keeps bookmarks that moved, or that no round recorded", async () => {
    await lr(repo, "review", "create");
    await repo.bookmark("feat/1-schema", c2);
    await lr(repo, "feature", "abandon", ...NICK);
    const r = await clean("feat");
    expect(r.features[0]).toMatchObject({
      forgotten: ["feat/2-rotation"],
      kept: [
        {
          bookmark: "feat/1-schema",
          reason: `it moved since round 1 (from ${c1.slice(0, 8)} to ${c2.slice(0, 8)})`,
        },
      ],
    });
  });

  test("an abandoned feature with no rounds keeps its bookmarks", async () => {
    await lr(repo, "feature", "abandon", ...NICK);
    const r = await clean();
    expect(r.features[0]).toMatchObject({ forgotten: [], workspace: false });
    expect(r.features[0]!.kept.map((k) => k.reason)).toEqual([
      "no review round recorded where it was",
      "no review round recorded where it was",
    ]);
    expect(r.opBefore).toBeNull();
  });

  test("--purge deletes the review history, for humans who name the feature", async () => {
    await finish();
    expect((await lr(repo, "feature", "clean", "--purge", ...NICK)).err).toContain(
      "--purge deletes review history for good, so name the features",
    );
    expect((await lr(repo, "feature", "clean", "feat", "--purge", ...AGENT)).err).toContain(
      "only a human can --purge review history",
    );
    const r = await clean("feat", "--purge", ...NICK);
    expect(r.features[0]!.purged).toBe(true);
    expect((await lr(repo, "feature", "list")).out).toBe("No features yet.");
    expect(existsSync(featureDir(repo.root, "feat"))).toBe(false);
  });

  test("only finished features", async () => {
    expect((await lr(repo, "feature", "clean")).out).toBe("No finished features.");
    expect((await lr(repo, "feature", "clean", "feat")).err).toContain(
      'feature "feat" is implementing; clean it once it\'s done, or abandon it first',
    );
    expect((await lr(repo, "feature", "clean", "nope")).err).toContain('no feature "nope"');
  });
});
