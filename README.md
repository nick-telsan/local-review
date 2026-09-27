# local-review

Local code review for agentic development, built on [jj](https://jj-vcs.github.io/jj/).

An agent plans a change, implements it as a stack of commits (one bookmark per phase), and
then runs `lr review create`. That snapshots the stack, runs your checks, and opens a review
round. You and a reviewer agent comment on code and on commit messages, and decide how commits
get squashed. The agent revises, and the loop repeats until the change is approved. Then it's
squashed into its final shape and handed off as a PR.

> **Status:** early. Snapshots, checks, and plans work today. Reviews, threads, handoff,
> finalization, and the UI are next. See [the design](docs/design/data-model.md).

## Requirements

- [jj](https://jj-vcs.github.io/jj/) 0.45+ (colocated git repos work)
- [Bun](https://bun.sh) 1.4.2 (pinned in `.tool-versions`)

## Usage

```sh
bun install
bun run build       # standalone binary at dist/lr; copy it onto your PATH
# or run from source: bun run lr …
```

```sh
lr feature start auth-refresh --base 'trunk()'
lr plan submit -F plan.md          # markdown with a `phases:` frontmatter block
# … implement: one commit per task, `jj bookmark set <phase bookmark>` when a phase is done …
lr review create                   # snapshot + checks; exits 1 if a check fails
lr status
```

Every command takes `--json`. Agents identify themselves with `--as agent:<name>` or
`$LR_ACTOR`.

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

Commits can reference tasks with a `Plan-Task: 1.1` trailer.

### Checks

Define checks in `.local-review.toml` at the repo root:

```toml
setup = "bun install --frozen-lockfile"   # optional, runs once per checked commit

[[checks]]
name = "test"
run = "bun test"
at = "bookmarks"      # "tip" (default) | "bookmarks" | "changes"
timeout = "10m"       # default 10m
```

Checks run in a separate jj workspace, so your working copy is never touched. A passing result
is reused as long as the commit and the command haven't changed.

State lives in `~/.local-review/` (override with `$LOCAL_REVIEW_HOME`).

## Development

```sh
bun run check       # lint + typecheck + tests with coverage (≥90% lines and functions, per file)
bun run fix         # format and apply safe lint fixes
bun test test/snapshot.test.ts   # one file, no coverage thresholds
```

## License

[Unlicense](LICENSE): public domain.
