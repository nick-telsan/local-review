import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { PlanVersion } from "../src/model.ts";
import { TestRepo, TWO_PHASE_PLAN } from "./helpers.ts";
import { lr, lrJson, lrWithStdin } from "./lr.ts";

let repo: TestRepo;
let planFile: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.commit("base", { "README.md": "hello\n" });
  await repo.bookmark("main");
  planFile = join(repo.tmp, "plan.md");
  await Bun.write(planFile, TWO_PHASE_PLAN);
});

afterEach(() => repo.cleanup());

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    stdin: async () => "",
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("argument handling", () => {
  test("no arguments, help, and --help print usage", async () => {
    for (const argv of [[], ["help"], ["status", "--help"]]) {
      const r = await run(...argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Usage:");
    }
  });

  test("unknown commands exit 2", async () => {
    const r = await run("frobnicate");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command: frobnicate");
  });

  test("unknown options exit 2", async () => {
    const r = await lr(repo, "status", "--bogus");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--bogus");
  });

  test("outside a jj repo", async () => {
    const r = await run("status", "-R", repo.tmp);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not in a jj repo");
  });

  test("invalid --as", async () => {
    const r = await lr(repo, "feature", "list", "--as", "robot:x");
    expect(r.code).toBe(1);
    expect(r.err).toContain('invalid actor "robot:x"');
  });
});

describe("lr feature", () => {
  test("start and list", async () => {
    expect((await lr(repo, "feature", "list")).out).toBe("No features yet.");
    const started = await lr(repo, "feature", "start", "auth", "--title", "Auth", "--base", "main");
    expect(started.code).toBe(0);
    expect(started.out).toContain("Started feature auth (base: main)");
    const list = await lr(repo, "feature", "list");
    expect(list.out).toMatch(/^auth\s+planning\s+plan v-\s+Auth$/);
  });

  test("rejects bad slugs, duplicates, and unresolvable bases", async () => {
    expect((await lr(repo, "feature", "start", "Bad_Slug")).err).toContain("usage:");
    expect((await lr(repo, "feature", "start")).err).toContain("usage:");
    await lr(repo, "feature", "start", "auth", "--base", "main");
    expect((await lr(repo, "feature", "start", "auth", "--base", "main")).err).toContain(
      "already exists",
    );
    const bad = await lr(repo, "feature", "start", "other", "--base", "no-such-bookmark");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("jj log");
  });
});

describe("feature resolution", () => {
  test("no active feature", async () => {
    const r = await lr(repo, "status");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no active feature");
  });

  test("several active features need --feature or $LR_FEATURE", async () => {
    await lr(repo, "feature", "start", "one", "--base", "main");
    await lr(repo, "feature", "start", "two", "--base", "main");
    expect((await lr(repo, "status")).err).toContain("several active features (one, two)");
    expect((await lr(repo, "status", "--feature", "two")).out).toContain("two: two");
    expect((await lr(repo, "status", "--feature", "nope")).err).toContain('no feature "nope"');
    process.env.LR_FEATURE = "one";
    expect((await lr(repo, "status")).out).toContain("one: one");
  });
});

describe("lr plan", () => {
  beforeEach(async () => {
    await lr(repo, "feature", "start", "feat", "--base", "main");
  });

  test("submit validates its input", async () => {
    expect((await lr(repo, "plan", "submit")).err).toContain("usage: lr plan submit -F <file>");
    expect((await lr(repo, "plan", "submit", "-F", "/no/such/plan.md")).err).toContain(
      "no such file",
    );
    expect((await lr(repo, "plan", "revise", "-F", planFile)).err).toContain(
      "use `lr plan submit`",
    );
  });

  test("show prints the current plan", async () => {
    expect((await lr(repo, "plan", "show")).err).toContain("has no plan yet");
    await lr(repo, "plan", "submit", "-F", planFile, "--as", "agent:claude-code");
    expect((await lr(repo, "plan", "show")).out).toBe(TWO_PHASE_PLAN);
    const { data } = await lrJson<{ plan: PlanVersion }>(repo, "plan", "show");
    expect(data.plan.createdBy).toEqual({ kind: "agent", name: "claude-code" });
    expect(await Bun.file(data.plan.path).text()).toBe(TWO_PHASE_PLAN);
  });

  test("submit reads the plan from stdin with -F -", async () => {
    const r = await lrWithStdin(repo, TWO_PHASE_PLAN, "plan", "submit", "-F", "-");
    expect(r.code).toBe(0);
    expect((await lr(repo, "plan", "show")).out).toBe(TWO_PHASE_PLAN);
  });

  test("status before any round", async () => {
    await lr(repo, "plan", "submit", "-F", planFile);
    const r = await lr(repo, "status");
    expect(r.out).toContain("Status: implementing");
    expect(r.out).toContain("Plan: v1");
    expect(r.out).toContain("Next: implement the plan");
  });

  test("review create needs a plan", async () => {
    const r = await lr(repo, "review", "create");
    expect(r.code).toBe(1);
    expect(r.err).toContain("has no plan yet");
  });
});
