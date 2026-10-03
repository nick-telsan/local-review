import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { CONFIG_TEMPLATE, type InitOk } from "../src/commands/init.ts";
import { CONFIG_FILE, loadRepoConfig } from "../src/config.ts";
import { TestRepo } from "./helpers.ts";
import { lr, lrJson } from "./lr.ts";

let repo: TestRepo;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
});

afterEach(() => repo.cleanup());

test("writes a commented config that changes nothing until edited", async () => {
  const r = await lrJson<InitOk>(repo, "init");
  expect(r.code).toBe(0);
  expect(r.data.path).toBe(join(repo.root, CONFIG_FILE));
  expect(await Bun.file(r.data.path).text()).toBe(CONFIG_TEMPLATE);
  const config = await loadRepoConfig(repo.root);
  expect(config.checks).toEqual([]);
  expect(config.setup).toBeNull();

  expect((await lr(repo, "init")).err).toContain(`${CONFIG_FILE} already exists`);
});

test("every example in it is valid once uncommented", async () => {
  await repo.write("docs/commit-messages.md", "");
  await repo.write(".github/pull_request_template.md", "");
  const uncommented = CONFIG_TEMPLATE.split("\n")
    .map((l) => l.replace(/^# (?=\[|[a-z_]+ = )/, ""))
    .join("\n");
  await repo.write(CONFIG_FILE, uncommented);
  const config = await loadRepoConfig(repo.root);
  expect(config.checks.map((c) => [c.name, c.at])).toEqual([
    ["test", "bookmarks"],
    ["lint", "tip"],
  ]);
  expect(config).toMatchObject({
    setup: "bun install --frozen-lockfile",
    review: { triageAgentComments: true },
    final: { commitGuidelines: "docs/commit-messages.md" },
    ui: { port: 4747 },
  });
});

test("says when features will need --base", async () => {
  const none = await lr(repo, "init");
  expect(none.out).toContain("Next: `lr feature start <slug> --base <bookmark>`. jj's trunk()");

  await Bun.$`rm ${join(repo.root, CONFIG_FILE)}`;
  await repo.jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
  const found = await lrJson<InitOk>(repo, "init");
  expect(found.data.trunk).toBe(true);
  expect((await Bun.$`rm ${join(repo.root, CONFIG_FILE)}`.quiet()).exitCode).toBe(0);
  expect((await lr(repo, "init")).out).toContain("Next: `lr feature start <slug>` (its base");
});
