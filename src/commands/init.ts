import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE } from "../config.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";

/** `lr init --json` output. */
export interface InitOk {
  /** The config file written. */
  path: string;
  /** Whether jj's `trunk()` finds a commit other than the root (else features need `--base`). */
  trunk: boolean;
}

/** Everything is commented out: a repo with no settings behaves the same with or without it. */
export const CONFIG_TEMPLATE = `# local-review (lr) settings for this repo. Everything is optional: uncomment what you need.

# Checks run before each review round (\`lr review create\`), and with \`lr check\`. They run in a
# separate jj workspace, so your working copy is never touched. A passing result is reused while
# the commit and the command stay the same.

# Runs once at each checked commit, before its checks, e.g. to install dependencies.
# setup = "bun install --frozen-lockfile"
# setup_kill_after = "30s"   # like kill_after, for setup

# [[checks]]
# name = "test"
# run = "bun test"
# at = "bookmarks"     # "tip" (the default): the top of the stack. "bookmarks": each phase's
#                      # last change. "changes": every non-empty change.
# timeout = "10m"      # the default
# kill_after = "30s"   # after a timeout, how long it gets to shut down before SIGKILL

# [[checks]]
# name = "lint"
# run = "bun run lint"

# What the author follows when drafting the final commit messages and the PR body. Paths are
# relative to the repo root.
# [final]
# commit_guidelines = "docs/commit-messages.md"
# pr_template = ".github/pull_request_template.md"   # the default, when that file exists

# Make agent reviewers' comments wait for a human to accept them before the author sees them.
# [review]
# triage_agent_comments = true

# The port \`lr ui\` serves on. The default is the same every time, derived from the repo's path.
# [ui]
# port = 4747
`;

/** Write a commented `.local-review.toml` to start from. */
export async function init(ctx: Context): Promise<number> {
  const path = join(ctx.jj.root, CONFIG_FILE);
  if (existsSync(path)) throw new LrError(`${CONFIG_FILE} already exists (${path})`);
  await Bun.write(path, CONFIG_TEMPLATE);

  const trunk = (await ctx.jj.commits("trunk() ~ root()")).length > 0;
  const json: InitOk = { path, trunk };
  ctx.print(json, [
    `Wrote ${CONFIG_FILE}. Everything in it is commented out; uncomment the checks you want.`,
    trunk
      ? "Next: `lr feature start <slug>` (its base is trunk() unless you pass --base)."
      : "Next: `lr feature start <slug> --base <bookmark>`. jj's trunk() looks for main, master, " +
        "or trunk on a remote, and this repo has none, so name the feature's base. (Or point " +
        "trunk() at a bookmark: jj config set --repo 'revset-aliases.\"trunk()\"' main)",
  ]);
  return 0;
}
