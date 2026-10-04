# Using lr

The [README](../README.md) covers installing lr and a first feature. This is the rest: the commands,
the files lr reads, and the Claude Code plugin. How lr works inside is in [the design](design/).

## Commands

`lr --help` lists every command and option.

### Yours

With Claude Code doing the authoring, these are the ones you run yourself:

```sh
lr init                  # once per repo: a commented .local-review.toml for your checks
lr ui                    # review in your browser: comment, reply, submit a verdict (? for keys)
lr status                # where the feature stands, and what's next
lr final cut <change>    # before the final round: split a phase into more than one final commit
lr feature abandon       # give up on a feature (its history and commits are kept)
lr feature clean         # once a feature lands: forget its bookmarks and checks workspace
lr repo relink           # after moving the repo: bring its review history along
```

### The agents'

The rest of the loop is run by the author agent (the `lr-author` skill walks it through) and by
reviewer agents. Here it is roughly in order, to follow along or to run it by hand:

```sh
lr feature start auth-refresh      # base: trunk(), or --base <revset>
lr plan submit -F plan.md          # markdown with a `phases:` frontmatter block
# … implement: one commit per task, `jj bookmark set <phase bookmark>` when a phase is done …
lr note kxqp src/db.ts:40-41 "Temporary until phase 3"   # for reviewers, not in the code
lr note @- "Split out for phase 2"                         # a revset works too
lr check                           # run the checks now, without opening a round
lr review create                   # snapshot + checks; exits 1 if a check fails
lr review submit -F review.json --as agent:codex        # a reviewer agent's review
lr review submit --verdict approved -m "LGTM"            # a human verdict, without the UI
lr handoff                         # what the author agent needs to act on, as markdown
lr reply 12 --addressed "Added NOT NULL in kxqp"         # author
lr reply 12 --resolve              # reviewer (or --reopen, --dismiss, --accept)
lr threads                         # unsettled threads (--notes: the author's notes)
lr diff                            # what changed since your last review, change by change
lr rebase                          # onto the feature's base (--onto <revset> for a new base)

# once you've approved with nothing open:
lr final show                      # final commits: one per phase (lr final cut <change> splits one)
lr final message 1 -F msg.txt      # draft each final commit's message…
lr final pr-body -F pr.md          # …and the PR body (or edit the files lr final show lists)
lr review create --final           # review the messages and PR body; approve with review submit
lr final apply                     # squash the stack exactly as approved (undo: jj op restore)
```

While `lr ui` runs, `lr review create`, `lr status` and `lr handoff` link to the round in it.

## A feature's base

A feature's base defaults to jj's `trunk()`, which finds `main`, `master` or `trunk` on a remote.
In a repo with no remote, that's the root commit, so name the base (`--base main`), or point
`trunk()` at your bookmark: `jj config set --repo 'revset-aliases."trunk()"' main`. If the base
would sweep in bookmarks that `@` builds on, `lr feature start` refuses a default base and warns
about one you named.

## Who's acting

Every command takes `--json`. Actors are `--as human:<name>` or `--as agent:<name>` (or
`$LR_ACTOR`). Inside a coding agent such as Claude Code, lr defaults to that agent, so an agent
can't approve as you by accident. In Claude Code's `!` commands, pass `--as <you>`.

## Plans

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

## Reviews

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
[the design](design/data-model.md#review-submissions).

## Checks

Define checks in `.local-review.toml` at the repo root (`lr init` writes one with every setting
commented out):

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
is reused as long as the commit and the command haven't changed. In `jj log`, the workspace's commit
is the empty one marked `lr-<feature>-checks@` and described as local-review's. It isn't part of
your stack, and `lr feature clean` removes it.

## Rebasing

Rebasing (with `lr rebase` or plain `jj rebase`) doesn't disturb a review. An approval survives a
clean rebase, because lr compares each change's own diff (`jj interdiff`), not commit ids. The checks
run again on the rebased commits before anything is finalized.

## Other settings

Everything else in `.local-review.toml` is optional too.

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

## Where lr keeps things

Plans, rounds, threads, drafts, and check logs live in `~/.local-review/`, one directory per repo
(override with `$LOCAL_REVIEW_HOME`). Nothing goes in your working copy except
`.local-review.toml`, which you commit. If you move a repo, `lr repo relink` brings its history
along.

## Claude Code

[`plugin/`](../plugin) is a Claude Code plugin with two skills and three hooks. The
[README](../README.md#install) has how to install it. It needs `lr` on your `PATH`.

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

### Skills and hooks without the plugin

The skills are plain skill directories. From a clone of this repo, link the ones you want, so they
follow the clone as it updates:

```sh
ln -s /path/to/local-review/plugin/skills/lr-author ~/.claude/skills/lr-author
ln -s /path/to/local-review/plugin/skills/lr-review ~/.claude/skills/lr-review
```

Or copy them, to keep them as they are:

```sh
cp -R /path/to/local-review/plugin/skills/lr-author ~/.claude/skills/
cp -R /path/to/local-review/plugin/skills/lr-review ~/.claude/skills/
```

Each hook in [`plugin/hooks/hooks.json`](../plugin/hooks/hooks.json) stands alone. Copy the ones you
want into the `hooks` object of `~/.claude/settings.json`, or into a project's
`.claude/settings.json`.
