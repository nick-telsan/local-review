import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, loadRepoConfig, parseDuration } from "../src/config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lr-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const load = async (toml: string) => {
  await Bun.write(join(dir, CONFIG_FILE), toml);
  return loadRepoConfig(dir);
};

describe("loadRepoConfig", () => {
  test("defaults when there's no config file", async () => {
    expect(await loadRepoConfig(dir)).toEqual({
      setup: null,
      checks: [],
      review: { triageAgentComments: false },
      final: { commitGuidelines: null, prTemplate: null },
    });
  });

  test("parses setup and checks with defaults", async () => {
    const config = await load(`
setup = "bun install"

[[checks]]
name = "test"
run = "bun test"
at = "bookmarks"
timeout = "90s"

[[checks]]
name = "lint"
run = "bun run lint"
`);
    expect(config).toEqual({
      setup: "bun install",
      checks: [
        { name: "test", run: "bun test", at: "bookmarks", timeoutMs: 90_000 },
        { name: "lint", run: "bun run lint", at: "tip", timeoutMs: 600_000 },
      ],
      review: { triageAgentComments: false },
      final: { commitGuidelines: null, prTemplate: null },
    });
  });

  test("reports every problem at once", async () => {
    const message = await load(`
setup = 3

[[checks]]
run = "x"

[[checks]]
name = "a"

[[checks]]
name = "b"
run = "x"
at = "sometimes"

[[checks]]
name = "c"
run = "x"
timeout = "soon"

[[checks]]
name = "c"
run = "x"
`).catch((e: Error) => e.message);
    expect(message).toContain("setup: must be a string");
    expect(message).toContain("checks[0].name: required");
    expect(message).toContain("checks[1].run: required");
    expect(message).toContain('checks[2].at: must be "tip", "bookmarks", or "changes"');
    expect(message).toContain("checks[3].timeout");
    expect(message).toContain('checks[4].name: duplicate check "c"');
  });

  test("review settings", async () => {
    expect((await load("[review]\ntriage_agent_comments = true\n")).review).toEqual({
      triageAgentComments: true,
    });
    await expect(load("[review]\ntriage_agent_comments = 1\n")).rejects.toThrow(
      /must be true or false/,
    );
    await expect(load('review = "x"\n')).rejects.toThrow(/must be a table/);
  });

  test("final settings", async () => {
    await expect(load('final = "x"\n')).rejects.toThrow(/final: must be a table/);
    await expect(load("[final]\ncommit_guidelines = 3\n")).rejects.toThrow(
      /final.commit_guidelines: must be a path/,
    );
    await expect(load('[final]\npr_template = "nope.md"\n')).rejects.toThrow(
      /final.pr_template: nope.md doesn't exist/,
    );
  });

  test("rejects checks that aren't an array of tables", async () => {
    await expect(load(`checks = "nope"`)).rejects.toThrow(/array of tables/);
  });

  test("rejects invalid TOML", async () => {
    await expect(load(`[[checks]\nname = `)).rejects.toThrow(CONFIG_FILE);
  });
});

test("parseDuration", () => {
  expect(parseDuration("90s")).toBe(90_000);
  expect(parseDuration("10m")).toBe(600_000);
  expect(parseDuration("250ms")).toBe(250);
  expect(parseDuration("1h")).toBe(3_600_000);
  expect(parseDuration("10 minutes")).toBeNull();
});
