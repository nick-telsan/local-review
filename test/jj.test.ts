import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatActor, parseActor, resolveActor } from "../src/actor.ts";
import { Jj, revsetString } from "../src/jj.ts";
import { featureDir, lrHome, repoKey } from "../src/paths.ts";
import { TestRepo } from "./helpers.ts";

describe("Jj", () => {
  let repo: TestRepo;
  beforeEach(async () => {
    repo = await TestRepo.create();
    await repo.commit("first", { "a.txt": "a\n" });
  });
  afterEach(() => repo.cleanup());

  test("discovers the repo root from a subdirectory", async () => {
    mkdirSync(join(repo.root, "nested", "dir"), { recursive: true });
    const jj = await Jj.discover(join(repo.root, "nested", "dir"));
    expect(jj.root).toBe(repo.root);
  });

  test("discover fails outside a repo", async () => {
    await expect(Jj.discover(repo.tmp)).rejects.toThrow(/not in a jj repo/);
  });

  test("diffGit returns a git-format patch", async () => {
    const patch = await new Jj(repo.root).diffGit("@-");
    expect(patch).toContain("diff --git a/a.txt b/a.txt");
    expect(patch).toContain("+a");
  });

  test("single requires exactly one commit", async () => {
    await expect(new Jj(repo.root).single("all()")).rejects.toThrow(/to one commit, got 3/);
  });

  test("failed commands surface jj's stderr", async () => {
    await expect(new Jj(repo.root).run(["log", "-r", "nope("])).rejects.toThrow(/jj log .* failed/);
  });

  test("revsetString quotes names safely", () => {
    expect(revsetString('feat/1-"x"')).toBe('"feat/1-\\"x\\""');
  });
});

describe("paths", () => {
  test("repo key is the dir name plus a stable hash of the root", () => {
    expect(repoKey("/a/b/my-repo")).toMatch(/^my-repo-[0-9a-f]{6}$/);
    expect(repoKey("/a/b/my-repo")).toBe(repoKey("/a/b/my-repo"));
    expect(repoKey("/a/b/my-repo")).not.toBe(repoKey("/c/my-repo"));
  });

  test("feature dirs live under $LOCAL_REVIEW_HOME", () => {
    process.env.LOCAL_REVIEW_HOME = "/lr-home";
    expect(lrHome()).toBe("/lr-home");
    expect(featureDir("/a/my-repo", "feat")).toBe(`/lr-home/${repoKey("/a/my-repo")}/feat`);
  });
});

describe("actors", () => {
  const env = { ...process.env };
  const VARS = ["LR_ACTOR", "USER", "CLAUDECODE", "AI_AGENT"] as const;
  beforeEach(() => {
    for (const v of VARS) delete process.env[v];
  });
  afterEach(() => {
    for (const v of VARS) {
      if (env[v] === undefined) delete process.env[v];
      else process.env[v] = env[v];
    }
  });

  test("flag, then $LR_ACTOR, then a detected agent, then $USER", () => {
    process.env.LR_ACTOR = "agent:codex";
    process.env.USER = "nick";
    process.env.CLAUDECODE = "1";
    expect(resolveActor("agent:claude-code")).toEqual({ kind: "agent", name: "claude-code" });
    expect(resolveActor(undefined)).toEqual({ kind: "agent", name: "codex" });
    delete process.env.LR_ACTOR;
    expect(resolveActor(undefined)).toEqual({ kind: "agent", name: "claude-code" });
    process.env.AI_AGENT = "cursor_1-2_agent";
    expect(resolveActor(undefined)).toEqual({ kind: "agent", name: "cursor" });
    delete process.env.CLAUDECODE;
    delete process.env.AI_AGENT;
    expect(resolveActor(undefined)).toEqual({ kind: "human", name: "nick" });
  });

  test("a bare name is a human", () => {
    expect(resolveActor("sam")).toEqual({ kind: "human", name: "sam" });
  });

  test("rejects unknown kinds and empty names", () => {
    expect(() => resolveActor("robot:x")).toThrow(/invalid actor/);
    expect(() => resolveActor("agent:")).toThrow(/invalid actor/);
  });

  test("format and parse round-trip", () => {
    const actor = { kind: "agent", name: "claude-code" } as const;
    expect(parseActor(formatActor(actor))).toEqual(actor);
  });
});
