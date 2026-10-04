# local-review

Local code review for agentic development, built on [jj](https://docs.jj-vcs.dev/).

An agent plans a change, implements it as a stack of commits (one bookmark per phase), and
then runs `lr review create`. That snapshots the stack, runs your checks, and opens a review
round. You and a reviewer agent comment on code and on commit messages, and decide how commits
get squashed. The agent revises, and the loop repeats until the change is approved. Then it's
squashed into its final shape and handed off as a PR.

> **Status:** early. The whole loop works: plans, checks, review rounds in the CLI and a web UI
> (`lr ui`), threads that follow the code from round to round, and finalization into one commit per
> phase with a PR body. Expect rough edges.

## Install

With [Homebrew](https://brew.sh), on macOS or Linux:

```sh
brew install nick-telsan/tap/local-review   # installs lr and jj
```

Or download `lr` for your platform from the
[releases](https://github.com/nick-telsan/local-review/releases), and put it on your `PATH`. It
needs [jj](https://docs.jj-vcs.dev/latest/install-and-setup/) 0.45 or later.

Then add the Claude Code plugin, which teaches Claude the author's and the reviewer's side:

```sh
claude plugin marketplace add nick-telsan/local-review
claude plugin install local-review@local-review
```

To build from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

## A first feature

lr works in any jj repo. In a git repo, `jj git init --colocate` adds jj alongside git.

```sh
lr init   # optional: a .local-review.toml with your checks, all commented out to start
```

New features start from jj's `trunk()`. If your repo has no `main`, `master` or `trunk` on a remote,
see [a feature's base](docs/usage.md#a-features-base).

Then, in Claude Code, ask for a feature: "Use lr to add refresh token rotation." Claude starts a
feature, writes a plan in phases, and shows it to you. Once you agree, it implements the plan one
commit per task and opens a review round. Then:

1. **Review.** `lr ui` opens the round in your browser: comment on lines, commit messages, or the
   plan, then finish with a verdict. For an agent's review first, run `/local-review:lr-review` in
   another Claude session.
2. **Revise.** Tell Claude the round is reviewed. It reads `lr handoff`, amends the commits in place,
   replies to each thread, and opens the next round. `lr diff` (or "since last review" in the UI)
   shows what changed.
3. **Finish.** Once you approve with nothing open, Claude drafts a message for each final commit and
   the PR body, and opens a final round for you to review. After you approve it, `lr final apply`
   squashes the stack, and it's ready to push.

`lr status` says where a feature stands and what's next.

## Docs

- [Using lr](docs/usage.md): the commands, plans, review files, checks, settings, and the plugin.
- [The design](docs/design/): how lr models features, rounds, and threads, and why.
- [CONTRIBUTING.md](CONTRIBUTING.md): building from source, tests, and releases.

## License

[Unlicense](UNLICENSE): public domain.
