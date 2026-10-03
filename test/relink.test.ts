import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoRelinkOk } from "../src/commands/repo.ts";
import { repoDir } from "../src/paths.ts";
import { Store } from "../src/store.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson } from "./lr.ts";

// main: README.md and a check; phase 1 (feat/1-schema): c1. Round 1 is open, so there's a
// checks workspace and a check log.
let repo: TestRepo;
let old: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", {
    "README.md": "hello\n",
    ".local-review.toml": '[[checks]]\nname = "ok"\nrun = "true"\n',
  });
  await repo.bookmark("main");
  await repo.commit("Add table", { "schema.sql": "create table t;\n" });
  await repo.bookmark("feat/1-schema");
  await lr(repo, "feature", "start", "feat", "--base", "main");
  await Bun.write(join(repo.tmp, "plan.md"), TWO_PHASE_PLAN);
  await lr(repo, "plan", "submit", "-F", join(repo.tmp, "plan.md"));
  expect((await lr(repo, "review", "create")).code).toBe(0);
  old = repo.root;
});

afterEach(() => repo.cleanup());

async function relink(moved: TestRepo, ...args: string[]): Promise<RepoRelinkOk> {
  const r = await lrJson<RepoRelinkOk>(moved, "repo", "relink", ...args);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.data;
}

const err = async (r: TestRepo, ...args: string[]) => (await lr(r, "repo", "relink", ...args)).err;

describe("lr repo relink", () => {
  test("finds the history of the repo it moved from, and brings it along", async () => {
    const moved = repo.moveTo("elsewhere/repo");
    // Before relinking, lr finds no history here, and says why that may be.
    expect((await lr(moved, "status")).err).toContain(
      `no active feature; start one with \`lr feature start <slug>\`; if this repo moved from ${old}, ` +
        "`lr repo relink` brings its review history along",
    );
    expect((await lr(moved, "feature", "list")).out).toContain(`No features yet; if this repo`);
    // Only for a repo of the same name: a renamed one could be any of them.
    const renamed = await repo.sibling("renamed");
    expect((await lr(renamed, "feature", "list")).out).toBe("No features yet.");

    expect(await relink(moved)).toEqual({
      from: old,
      to: moved.root,
      features: ["feat"],
      workspaces: ["feat"],
    });
    expect(existsSync(repoDir(old))).toBe(false);
    expect(JSON.parse(readFileSync(join(repoDir(moved.root), "repo.json"), "utf8")).root).toBe(
      moved.root,
    );
    expect((await lr(moved, "status")).out).toContain("Round 1");
    expect((await moved.jj("workspace", "list", "-T", 'name ++ "\\n"')).trim()).toBe("default");

    // Check logs follow the history.
    const store = await Store.open(moved.root);
    const [run] = store.roundChecks("feat", 1);
    store.close();
    expect(run!.logPath.startsWith(`${repoDir(moved.root)}/`)).toBe(true);
    expect(existsSync(run!.logPath)).toBe(true);

    // The next check run makes a new checks workspace.
    await moved.commit("Rotate", { "rotate.ts": "export {};\n" });
    await moved.bookmark("feat/2-rotation");
    const next = await lr(moved, "review", "create");
    expect(next.code).toBe(0);
    expect(next.out).toContain("Checks: 1/1 passed");
    expect(await moved.jj("workspace", "list", "-T", 'name ++ "\\n"')).toContain("lr-feat-checks");
  });

  test("from a path given", async () => {
    const moved = repo.moveTo("moved");
    const r = await lr(moved, "repo", "relink", old);
    expect(r.out).toBe(
      `Relinked ${old} → ${moved.root}: 1 feature (feat)\n` +
        "Forgot the checks workspace of feat; the next check run makes a new one.",
    );
  });

  test("history with no rounds needs the path", async () => {
    const other = await repo.sibling("other");
    await lr(other, "feature", "start", "later");
    const otherRoot = other.root;
    const moved = other.moveTo("other-moved");
    expect(await err(moved)).toContain(
      "found no review history whose recorded commits are in this repo; pass the path it moved " +
        `from: \`lr repo relink <old path>\`\nHistory for repos that are gone: ${otherRoot}`,
    );
    expect(await relink(moved, otherRoot)).toMatchObject({ features: ["later"], workspaces: [] });
  });

  test("refuses history that isn't this repo's", async () => {
    const other = await repo.sibling("other");
    expect(await err(other)).toBe(
      "error: found no review history whose recorded commits are in this repo; pass the path it " +
        "moved from: `lr repo relink <old path>`",
    );
    expect(await err(other, other.root)).toContain(`this repo is already at ${other.root}`);
    expect(await err(other, "/nowhere")).toContain("lr has no review history for /nowhere");
    expect(await err(other, old)).toContain(
      `${old} is still a jj repo; relink is for a repo that moved`,
    );
    repo.moveTo("moved");
    expect(await err(other, old)).toContain(
      `this repo has none of the commits ${old}'s review rounds recorded`,
    );
  });

  test("won't merge into a repo that has history of its own", async () => {
    const moved = repo.moveTo("moved");
    await lr(moved, "feature", "start", "other", "--base", "main");
    expect(await err(moved, old)).toContain(
      `this repo already has review history (other), so lr can't bring ${old}'s along`,
    );
  });

  test("asks when several moved repos match", async () => {
    // A second copy of the history, for a repo that's also gone.
    const copy = "/gone/repo";
    cpSync(repoDir(old), repoDir(copy), { recursive: true });
    const repoJson = join(repoDir(copy), "repo.json");
    writeFileSync(repoJson, JSON.stringify({ root: copy, createdAt: "then" }));
    const moved = repo.moveTo("moved");
    const e = await err(moved);
    expect(e).toContain("the history of several moved repos matches this one");
    expect(e).toContain(old);
    expect(e).toContain(copy);
    expect(await relink(moved, copy)).toMatchObject({ from: copy });
  });
});
