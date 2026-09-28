---
name: lr-review
description: Review a local-review (lr) round as an agent reviewer. Checks the jj stack against its plan and each phase's done_when, comments on code and commit messages, settles threads the author marked addressed, and submits the whole review with `lr review submit`. Also reviews final rounds (the squashed commits' messages and the PR body). Use when asked to review an lr feature or round, or to re-check addressed threads.
argument-hint: "[feature]"
---

# Reviewing a round with local-review

The author, another agent, implemented a plan as a stack of jj changes. `lr review create` then
opened a **round**: a frozen snapshot of that stack. Your review reaches the author through
`lr handoff`. The developer reviews too, and only their verdict decides the round. So aim to be
specific and useful, not exhaustive.

If a feature slug was given (`$ARGUMENTS`), add `--feature <slug>` to every lr command.

## Identity

Add `--as agent:claude-review` to **every** lr command. Shell state doesn't carry over between
commands, so it has to be on each one. Without it, lr records you as `agent:claude-code`, the
author's identity. Never act as a human.

## 1. Gather context

```sh
lr status --json --as agent:claude-review     # the round: change and commit ids, checks, reviews
lr plan show --as agent:claude-review         # phases, done_when, bookmarks, the plan's reasoning
lr threads --all --json --as agent:claude-review   # earlier threads, so you don't repeat them
```

Read the round by **commit id** (`round.changes[].commitId` in the status JSON), not change id. The
author may already be editing, and commit ids show exactly what was snapshotted.

- One change, message and diff: `jj show --git <commitId>`
- A phase or the whole stack: `jj diff --git --from <commit before it> --to <last commitId>`. The
  stack's base is `round.baseCommitId`.
- A file as of a change: `jj file show -r <commitId> <path>`
- A failing check's log: its path is in the status JSON.

Don't write files inside the repo. jj would snapshot them into the author's change.

## 2. Review

In priority order:

1. **The plan.** Does each phase meet its `done_when`? Does the stack do what the plan says? Missing
   or wrong work is blocking.
2. **Correctness:** bugs, edge cases, error handling, security, data loss.
3. **Tests:** is the change covered, and do the tests check the right thing?
4. **Commit structure.** Is each change one coherent step, in the right phase? Messages need an
   imperative subject, an accurate summary, and a body that says why when that isn't obvious.
5. **Design and readability,** in proportion. Skip what a formatter or linter would catch.

On a later round, start with the threads the author replied to and the changes they touched.

## 3. Settle earlier threads

For each thread **you** raised that the author marked `addressed`, check the fix in this round.
For a thread on code or a message, `originalAnchor.commitId` in `lr threads --json` is the change as
you commented on it. `jj interdiff --git --from <that commit> --to <its commitId in this round>` shows
what the author changed in it since. Use interdiff rather than `jj diff`, which would also show
everything that landed on the base if the stack was rebased.

```sh
lr reply <id> --resolve --as agent:claude-review                       # fixed
lr reply <id> --reopen "<what's still wrong>" --as agent:claude-review # not fixed
```

When the author pushed back (a reply on a thread that's still `open`), either agree and `--resolve`
or `--dismiss` it, or reply with your reasoning. Leave other reviewers' threads to them; you can
still reply.

## 4. Write and submit the review

A review is one JSON document: an optional verdict, a summary, and comments. Every location is
checked against the round's snapshot. If any location is wrong, nothing is recorded and every
problem is listed, so fix them and submit again.

```sh
lr review submit -F - --as agent:claude-review <<'EOF'
{ …review JSON… }
EOF
```

```json
{
  "verdict": "changes_requested",
  "body": "Phase 1 is solid. Phase 2 misses reuse detection (see the rotation comment).",
  "comments": [
    { "change": "kxqp", "path": "src/db.ts", "lines": [40, 41], "severity": "blocking",
      "body": "Both need NOT NULL, or a missing expiry never expires.",
      "suggestion": "  expires_at: timestamp().notNull(),\n  family_id: uuid().notNull()," },
    { "change": "vtzq", "message": true, "lines": 1, "severity": "nit",
      "body": "Imperative subject: \"Rotate tokens on use\"." },
    { "phase": 2, "severity": "blocking", "body": "done_when says reuse revokes the family; nothing does that yet." },
    { "path": "src/auth.ts", "lines": 12, "side": "old", "severity": "question",
      "body": "Why was this check removed?" },
    { "body": "Consider a feature flag for the rotation." }
  ]
}
```

Where a comment lands:

- **Code:** `path` and `lines` (a number, or `[first, last]`, 1-based). These are line numbers in
  the file as of the commit, not positions in the diff. With `change` (a unique prefix of its change
  id), the comment is on that change's diff. With `phase`, it's on the phase's combined diff. With
  neither, it's on the whole stack, reading the file at the tip. `"side": "old"` points at the file
  before the diff, for code that was removed.
- Put a comment on the change **where the fix belongs**. The author fixes each change in place.
- **A commit message:** `change` plus `"message": true`, optionally with `lines` within the
  message.
- **A whole change, a phase, or the feature:** `change`, `phase`, or neither, with no `path`.
- `severity` is `blocking` (must fix before approval), `suggestion`, `nit`, or `question`.
- `suggestion` is exact replacement text for the commented lines. It needs `lines`.

**Verdict:** use `changes_requested` if anything is blocking or the plan isn't met. Use `approved` if
you'd ship it; non-blocking comments can still be open. Leave the verdict out for comments only.

Finish by telling whoever asked: the verdict, the blocking issues, and how many comments you left.

## Final rounds

A final round (`"kind": "final"` in `lr status --json`) reviews the *finished* commits. The code
was already approved. The round's `final` field lists each group (the changes squashed into one
commit, with its message) and the PR body. Check that:

- each message describes its whole commit accurately, follows the repo's commit guidelines
  (`lr final show --json` includes them), and has an imperative subject;
- the PR body explains what and why, and says how it was tested, following the repo's PR template
  if there is one;
- the grouping makes sense. If a phase should be split, say so in a comment. Cuts are the
  developer's call.

Comment on a message with `final` (the group id) or on the PR body with `pr_body`, optionally with
`lines`:

```json
{
  "verdict": "changes_requested",
  "comments": [
    { "final": "2a", "lines": 1, "severity": "nit", "body": "Say what rotates.",
      "suggestion": "Rotate refresh tokens on every use" },
    { "pr_body": true, "lines": [3, 4], "body": "Mention the migration needs a backfill." },
    { "pr_body": true, "body": "Add how you tested this." }
  ]
}
```

Code comments still work in a final round, but anything that needs a code change sends the feature
back to a code round.
