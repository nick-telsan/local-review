---
name: lr-author
description: Author workflow for local-review (lr), a local code review loop on jj. Use when planning, implementing, or revising a feature that lr tracks. That covers writing the phased plan, committing one change per task with a bookmark per phase, opening review rounds with `lr review create`, and acting on `lr handoff` by amending changes and replying to threads. Also use when the session context says lr is tracking the repo, or the user asks to start a feature with lr.
---

# Authoring a feature with local-review

`lr` runs a review loop over a stack of jj changes:

```
plan → implement → lr review create → reviews → lr handoff → revise → lr review create → … → approved
```

You're the author. Reviewers (agents first, then the developer) comment on code and on commit
messages. You revise the stack in place and answer every thread. Only the developer approves.

## Ground rules

- Use `jj` for all version control, never `git commit`, `git rebase`, or `git checkout`. The repo
  may be colocated with git, but lr reads jj.
- lr records you as `agent:claude-code` on its own. Never pass `--as human:…` or set `LR_ACTOR` to
  a human. Human reviews and verdicts come from the developer.
- Don't write plans or other scratch files inside the repo: jj snapshots the working copy, so they'd
  land in a change. Pipe them in with `-F -` and a heredoc, or keep them outside the repo.
- `lr status` shows where the feature stands and what's next. Every lr command takes `--json`.
- Don't resolve or dismiss threads. That's the reviewer's call.

## 1. Start and plan

Run `lr status` first, since a feature may already exist. To start one:

```sh
lr feature start <slug> --base 'trunk()'   # slug: lowercase-with-hyphens; it prefixes bookmarks
```

Write the plan as markdown with a `phases:` frontmatter block. [plan-format.md](plan-format.md)
has the format and what makes a good phase. Show the plan to the developer before submitting it,
unless they've told you to go ahead. Then:

```sh
lr plan submit -F - <<'EOF'
---
phases:
  …
---
# Title
…
EOF
```

`lr plan show` prints the phases with their bookmark names, then the plan.

## 2. Implement

Build the stack on the feature's base, one change per task, in plan order. Start with `jj new <base>`
if the working copy isn't already there.

- Finish each task with `jj commit -m "<message>"`. That describes the working-copy change and
  starts a new, empty one on top.
- Messages: an imperative subject ("Add refresh token table"), a body that says why when it isn't
  obvious, and a `Plan-Task: <id>` trailer as the last line. Reviewers comment on messages too.
- When a phase's last task is committed, point the phase's bookmark at it:
  `jj bookmark set <bookmark> -r @-`.
- Keep the stack linear: no merges, no side branches. lr assigns each change to the phase of the
  nearest bookmark above it.
- Follow the repo's own conventions (CLAUDE.md, tests, linters), and run its checks as you go.

## 3. Open a review round

When every phase is done, or the developer asks for a round, run `lr review create`. It snapshots
the stack, runs the checks in `.local-review.toml`, and opens round N.

- Exit code 1 means no round was opened. Either a check failed (the output has its log path) or a
  change is conflicted. Fix it in the change where it belongs and run it again. Only use
  `--allow-failing` if the developer says so.
- Read the warnings: undescribed changes, changes outside every phase, phases with no changes.
- It also carries open threads from earlier rounds onto the new stack, and reports which moved or
  went outdated.

Then stop and tell the developer the round is open, with a short summary of the stack. Don't review
your own work. If the developer wants an agent review, it runs in a separate context (a subagent or
another session) with the lr-review skill.

## 4. Revise after review

When `lr status` says changes were requested, read all of `lr handoff`. It has the verdict, any
failing checks, every open thread with its code or message snippet, and next steps.

1. **Revise the plan.** Cover every open thread, including the ones you'll push back on, and why.
   Start from `lr plan show`, keep phase ids and bookmarks stable, and submit with
   `lr plan revise -F -`.
2. **Fix each thread in the change it's on.** The handoff groups threads by change. Amend in place;
   don't stack fixup commits.
   - `jj edit <change>` puts the working copy on that change, so edits amend it directly. That's
     the safe default, because you see the files as they are in that change. When you're done,
     `jj new <top of stack>` to get back.
   - For a message: `jj describe <change> -m "<new message>"`.
   - Descendants rebase on their own. Check `jj log` for conflicts and resolve each one in the
     change where it appears.
   - If a phase gains or loses its last change, move its bookmark:
     `jj bookmark set <bookmark> -r <change> --allow-backwards`.
3. **Reply to every open thread:**
   - `lr reply <id> --addressed "<what changed, in which change>"` once it's fixed.
   - `lr reply <id> "<why not>"` to push back or ask a question. The thread stays open for the
     reviewer.
4. **Open the next round** with `lr review create`, and tell the developer what changed.

A thread marked **outdated** points at code or a message that changed after the comment was made.
The handoff shows it as it was then. Check whether your change already dealt with it, and reply
either way.

## 5. Approved

Approved with nothing open means review is done. Finalization (squashing to one commit per phase,
drafting the PR body) isn't in lr yet, so stop and tell the developer. Approved with open threads
means: address them, then run `lr review create` for one last look.
