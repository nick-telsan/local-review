# CLI

Every command, who runs it, and what it does. `lr --help` has their options.

| Command                                                                  | Who            | Effect                                                                        |
| ------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------- |
| `lr init`                                                                | developer      | write a commented `.local-review.toml`                                        |
| `lr feature start <slug> [--base <revset>]`                              | author agent   | create feature (see [Feature](data-model.md#feature) for the base checks)                              |
| `lr plan submit\|revise -F <file>`                                       | author agent   | new plan version (validates frontmatter)                                      |
| `lr note <change> [<path>:<a>[-<b>] [--old]] "<text>"`                   | author agent   | a note for reviewers on your own change (see [Notes](data-model.md#notes))                           |
| `lr review create [--allow-failing] [--skip-checks]`                     | author agent   | snapshot + checks, then re-anchor threads; if a check fails, it exits non-zero and no round is opened |
| `lr check [<change>…] [--check <name,…>] [--round <n>] [--rerun]`       | anyone         | run checks by hand, on the stack now or a round's commits (see [Checks](checks.md))       |
| `lr review create --final`                                               | author agent   | a final round (see [Finalization](finalization.md))                                              |
| `lr review submit [-F <review.json>] [--verdict] [-m] [--round]`          | reviewer       | whole review, all comments at once (see [Review submissions](data-model.md#review-submissions))                   |
| `lr handoff [--round] [--json]`                                          | author agent   | read the handoff                                                              |
| `lr diff [<change>] [--from <n>] [--to <n>] [--name-only]`              | anyone         | what changed between rounds, change by change (see below)                     |
| `lr reply <thread> [--addressed\|--resolve\|--dismiss\|--reopen\|--accept] "<text>"` | anyone | thread entry / status (see [Thread](data-model.md#thread))                                    |
| `lr threads [--status <s,…>\|--all] [--notes]`                           | anyone         | list threads, or notes                                                        |
| `lr final show` · `lr final message <group> -F` · `lr final pr-body -F`  | author agent   | draft the final commits (see [Finalization](finalization.md))                                    |
| `lr final cut <change> [--remove]`                                       | developer      | split a phase into more than one final commit                                 |
| `lr final apply`                                                         | anyone         | squash the stack as approved                                                  |
| `lr status [--json]`                                                     | anyone         | feature state + what's expected next                                          |
| `lr rebase [--onto <revset>]`                                            | anyone         | rebase the stack onto its base (`--onto`: a new base); see [Rebase](data-model.md#rebase)             |
| `lr hook session-start\|pre-tool-use\|stop`                              | Claude Code    | hook handlers; see [Claude Code integration](claude-code.md)                                    |
| `lr feature abandon [<slug>]`                                            | human          | give up on a feature (history and commits are kept)                           |
| `lr feature clean [<slug>…] [--purge]`                                   | anyone; `--purge`: human | tidy up after finished features (see below)                         |
| `lr repo relink [<old path>]`                                            | developer      | bring review history along after the repo moves (see below)                   |
| `lr ui [--port <n>] [--no-open]`                                         | developer      | the review UI in the browser (see [Web UI](web-ui.md))                                     |

## `lr feature clean`

`lr feature clean` tidies up after done and abandoned features: the ones named, or all of them. It
refuses a feature that's still active.

- **Phase bookmarks** (from the current plan, and the plan of the last round) are forgotten if
  they're still on the change where the last round saw them. That includes after `lr final apply`,
  since squashing keeps each group's last change id. A bookmark that moved, is conflicted, or that
  no round ever recorded is kept, with the reason. Forgetting (`jj bookmark forget`) never touches
  a remote: remote bookmarks they tracked become untracked. Deleting the pushed branch is left to
  the developer or the forge.
- **The checks workspace** is forgotten, and its directory removed.
- **Commits are never touched.**
- **Review history is kept** (plans, rounds, threads, drafts, check logs) unless `--purge`, which
  deletes the feature's state and directory. `--purge` needs a human and named features, because
  there's no undo.

It prints the jj operation to restore to undo the bookmark and workspace changes.

## `lr diff`

`lr diff` compares two rounds change by change: by default the latest round against the last one
the actor reviewed, or else the one before it. Each change is `added`, `removed` (abandoned, or
squashed into the change named), `changed`, or `unchanged`. A changed change's patch is
`jj interdiff --git` between its two commits, so a rebase alone changes nothing, and a message edit
shows as a `JJ-COMMIT-DESCRIPTION` file. A change that moved phases, or is conflicted, counts as
changed. If the earlier commit is gone (`jj util gc`), it shows the whole change and says so.

## `lr repo relink`

`lr repo relink` moves a repo's review history to where the repo is now. Without a path, it looks
for history whose repo is gone and whose latest rounds recorded commits this repo has; it relinks
the one match, and otherwise asks for the old path. Given a path, it refuses one that's still a jj
repo (a copy isn't a move), or whose rounds recorded none of this repo's commits. It renames the
key directory, points `repo.json` and the check log paths at the new place, and replaces the empty
state that any lr command run here before relinking left behind. It won't merge two histories.
Checks workspaces find their repo by a relative path, which the move broke, so relink forgets them
and removes their directories; the next check run makes new ones. Until the repo is relinked,
commands that find no features here say so when history for a gone repo of the same name exists.
