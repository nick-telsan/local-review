# local-review

Local code review for agentic development, built on [jj](https://jj-vcs.github.io/jj/).

An agent plans a change, implements it as a stack of commits (one bookmark per phase), and
then runs `lr review create`. That snapshots the stack, runs your checks, and opens a review
round. You and a reviewer agent comment on code and on commit messages, and decide how commits
get squashed. The agent revises, and the loop repeats until the change is approved. Then it's
squashed into its final shape and handed off as a PR.

> **Status:** early. The review loop works end to end: plans, snapshots, checks, reviews, the
> handoff, threaded replies, comments that follow the code from round to round, finalization
> (squashing and the PR body), and a Claude Code plugin. The web UI (`lr ui`) shows rounds, diffs,
> and threads, updates live, and lets you review: comment on lines of code, messages, final commits,
> and the PR body, reply, resolve, and submit a verdict. It shows the plan next to what the round
> implements. It can also show only what changed since your last review. See [the design](docs/design/data-model.md).

## Requirements

- [jj](https://jj-vcs.github.io/jj/) 0.45+ (colocated git repos work)
- [Bun](https://bun.sh) 1.4.2 (pinned in `.tool-versions`)

## Usage

```sh
bun install
bun run build       # standalone binary at dist/lr; copy it onto your PATH
```

To track your checkout instead of a build, put a shim named `lr` on your `PATH`:

```sh
#!/bin/sh
exec bun /path/to/local-review/src/bin.ts "$@"
```

The shim runs whichever `bun` resolves where you run `lr`, which with asdf may not be the pinned one
outside this repo. `lr ui` needs Bun 1.4.2 or later, and says so if it gets an older one.

```sh
lr feature start auth-refresh --base 'trunk()'
lr plan submit -F plan.md          # markdown with a `phases:` frontmatter block
# … implement: one commit per task, `jj bookmark set <phase bookmark>` when a phase is done …
lr note kxqp src/db.ts:40-41 "Temporary until phase 3"   # for reviewers, not in the code
lr check                           # run the checks now, without opening a round
lr review create                   # snapshot + checks; exits 1 if a check fails
lr review submit -F review.json --as agent:codex        # a reviewer agent's review
lr review submit --verdict approved -m "LGTM"            # yours
lr handoff                         # what the author agent needs to act on, as markdown
lr reply 12 --addressed "Added NOT NULL in kxqp"         # author
lr reply 12 --resolve              # reviewer (or --reopen, --dismiss, --accept)
lr threads                         # unsettled threads (--notes: the author's notes)
lr diff                            # what changed since your last review, change by change
lr status
lr ui                              # review in your browser: comment, reply, submit a verdict (? for keys)
                                   # (while it runs, review create/status/handoff link to the round)
lr rebase                          # onto the feature's base (--onto <revset> for a new base)

# once you've approved with nothing open:
lr final show                      # final commits: one per phase (lr final cut <change> splits one)
lr final message 1 -F msg.txt      # draft each final commit's message…
lr final pr-body -F pr.md          # …and the PR body (or edit the files lr final show lists)
lr review create --final           # review the messages and PR body; approve with review submit
lr final apply                     # squash the stack exactly as approved (undo: jj op restore)
lr feature clean                   # once it lands: forget finished features' bookmarks
lr repo relink                     # after moving the repo: bring its review history along
```

Every command takes `--json`. Actors are `--as human:<name>` or `--as agent:<name>` (or
`$LR_ACTOR`). Inside a coding agent such as Claude Code, lr defaults to that agent, so an agent
can't approve as you by accident. In Claude Code's `!` commands, pass `--as <you>`.

### Plans

```md
---
phases:
  - id: 1
    title: Schema + migration
    done_when: migrations apply cleanly
    tasks:
      - { id: "1.1", title: Add refresh_tokens table }
  - id: 2
    title: Token rotation
    bookmark: auth-refresh/rotation   # default: <feature>/<id>-<title-slug>
---
# Refresh token rotation

Freeform context, decisions, risks…
```

Commits can reference tasks with a `Plan-Task: 1.1` trailer (several: `Plan-Task: 1.1, 1.2`, or
one trailer each). The web UI's plan page shows which tasks the round's changes name, and `lr status` and
`lr handoff` list the gaps: tasks no change names, unknown task ids, and changes naming no task.

### Reviews

A review file has an optional verdict, a summary, and comments on the feature, a phase, a
change, a commit message, or specific lines of code:

```json
{
  "verdict": "changes_requested",
  "body": "Close. See the schema comment.",
  "comments": [
    { "change": "kxqp", "path": "src/db.ts", "lines": [40, 41], "severity": "blocking",
      "body": "Both need NOT NULL.", "suggestion": "expires_at: timestamp().notNull()," },
    { "change": "kxqp", "message": true, "severity": "nit", "body": "Imperative subject." },
    { "body": "Feature-flag the rotation." }
  ]
}
```

Every location is checked against the round's snapshot, and a review with any bad location is
rejected as a whole, with every problem listed. The full format is in
[the design](docs/design/data-model.md#review-submissions).

### Checks

Define checks in `.local-review.toml` at the repo root:

```toml
setup = "bun install --frozen-lockfile"   # optional, runs once per checked commit
setup_kill_after = "30s"                  # like kill_after, for setup

[[checks]]
name = "test"
run = "bun test"
at = "bookmarks"      # "tip" (default) | "bookmarks" | "changes"
timeout = "10m"       # default 10m
kill_after = "30s"    # after a timeout, how long it gets to shut down before SIGKILL
```

Checks run in a separate jj workspace, so your working copy is never touched. A passing result
is reused as long as the commit and the command haven't changed.

Rebasing (with `lr rebase` or plain `jj rebase`) doesn't disturb a review. An approval survives a
clean rebase, because lr compares each change's own diff (`jj interdiff`), not commit ids. The checks
run again on the rebased commits before anything is finalized.

For drafting final commit messages and the PR body, point lr at your guidelines. The PR template
defaults to `.github/pull_request_template.md`:

```toml
[final]
commit_guidelines = "docs/commit-messages.md"
pr_template = ".github/pull_request_template.md"
```

To require a human to accept agent reviewers' comments before they reach the author:

```toml
[review]
triage_agent_comments = true
```

`lr ui` serves each repo on its own port, the same every time (47000–47999, from the repo's path),
so the links other commands print keep working after a restart. To pick the port yourself (`--port`
still overrides it):

```toml
[ui]
port = 4747
```

State lives in `~/.local-review/` (override with `$LOCAL_REVIEW_HOME`).

## Claude Code

[`plugin/`](plugin) is a Claude Code plugin with two skills and three hooks. It needs `lr` on your
`PATH`.

- **`lr-author`** (skill) walks through the author's side: planning, implementing (a change per
  task, a bookmark per phase), opening rounds, and revising from `lr handoff`.
- **`lr-review`** (skill) reviews a round as an agent. Run it in a separate session or subagent
  with `/local-review:lr-review`.
- **SessionStart** (hook) tells Claude which feature lr is tracking and what's next, including after
  `/clear` and compaction.
- **PreToolUse** (hook) asks you before Claude runs lr as a human (`--as human:…`, or `lr ui`).
- **Stop** (hook): if Claude changed the stack during the session and stops without opening a round,
  it gets one reminder to run `lr review create` or say what's left. Turn it off with the plugin's
  `stop_reminder` option in `/config`.

### As a plugin

```sh
claude plugin marketplace add /path/to/local-review
claude plugin install local-review@local-review
```

### Skills and hooks on their own

The skills are plain skill directories. Link or copy the ones you want:

```sh
ln -s /path/to/local-review/plugin/skills/lr-author ~/.claude/skills/lr-author
ln -s /path/to/local-review/plugin/skills/lr-review ~/.claude/skills/lr-review
```

Each hook in [`plugin/hooks/hooks.json`](plugin/hooks/hooks.json) stands alone. Copy the ones you
want into the `hooks` object of `~/.claude/settings.json`, or into a project's
`.claude/settings.json`.

## Development

```sh
bun run check       # lint + typecheck + tests with coverage (≥90% lines and functions, per file)
bun run fix         # format and apply safe lint fixes
bun test test/snapshot.test.ts   # one file, no coverage thresholds
claude plugin validate . && claude plugin validate plugin
claude --plugin-dir plugin       # try the plugin without installing it
```

## License

[Unlicense](LICENSE): public domain.
