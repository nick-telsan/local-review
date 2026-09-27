import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway jj repo with an isolated jj config and local-review home. */
export class TestRepo {
  private constructor(
    readonly tmp: string,
    readonly root: string,
  ) {}

  static async create(): Promise<TestRepo> {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "lr-test-")));
    const config = join(tmp, "jj-config.toml");
    await Bun.write(config, `user.name = "Test"\nuser.email = "test@example.com"\n`);
    process.env.JJ_CONFIG = config;
    process.env.LOCAL_REVIEW_HOME = join(tmp, "home");
    delete process.env.LR_FEATURE;
    delete process.env.LR_ACTOR;
    // Tests may run inside a coding agent, which lr would otherwise detect as the actor.
    delete process.env.CLAUDECODE;
    delete process.env.AI_AGENT;

    const root = join(tmp, "repo");
    await run(["jj", "git", "init", root], tmp);
    return new TestRepo(tmp, root);
  }

  cleanup(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }

  async jj(...args: string[]): Promise<string> {
    return run(["jj", "--no-pager", "--color=never", ...args], this.root);
  }

  async write(path: string, content: string): Promise<void> {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    await Bun.write(join(this.root, path), content);
  }

  /** Write files into @, describe it, and start a new change on top. Returns the change id. */
  async commit(message: string, files: Record<string, string> = {}): Promise<string> {
    for (const [path, content] of Object.entries(files)) await this.write(path, content);
    const id = (await this.jj("log", "--no-graph", "-r", "@", "-T", "change_id")).trim();
    await this.jj("commit", "-m", message);
    return id;
  }

  async bookmark(name: string, rev = "@-"): Promise<void> {
    await this.jj("bookmark", "set", name, "-r", rev, "--allow-backwards");
  }

  async commitId(rev: string): Promise<string> {
    return (await this.jj("log", "--no-graph", "-r", rev, "-T", "commit_id")).trim();
  }
}

async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err}`);
  return out;
}

export const TWO_PHASE_PLAN = `---
phases:
  - id: 1
    title: Schema
    bookmark: feat/1-schema
    tasks:
      - { id: "1.1", title: Add table }
      - { id: "1.2", title: Backfill }
  - id: 2
    title: Rotation
    bookmark: feat/2-rotation
---
# Plan

Body.
`;
