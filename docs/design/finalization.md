# Finalization

After a human approves a code round with nothing left open, the feature is `finalizing`:

```
finalizing ──lr review create --final──► final_review ──human approves──► approved ──lr final apply──► done
    ▲                                         │
    └──────────── changes requested ──────────┘
```

**Squash groups.** The approved round's changes are grouped into the commits of the finished
feature. There's one group per phase by default, named by phase id (`1`, `2`). `lr final cut <change>`
starts a new group at a change, splitting its phase (`2a`, `2b`). Only the developer should do that.
Moving changes between phases and reordering are out of scope. Every change must be in a phase.

**Drafts.** Each group's message and the PR body are plain files in the feature directory
(`final/messages/<group>.md`, `final/pr.md`). They're written with `lr final message <group> -F` and
`lr final pr-body -F`, or edited directly by the developer. `lr final show` lists the groups with
their changes and drafts. Its `--json` includes the commit guidelines and PR template from
`[final]` in `.local-review.toml` (`commit_guidelines`, and `pr_template`, which defaults to
`.github/pull_request_template.md`). A cut clears the drafted messages of its phase, since their
group ids change.

**Final rounds.** `lr review create --final` opens a round of kind `final`. It carries the stack and
freezes the drafts:

```ts
interface FinalSnapshot {
  approvedRound: number; // the code round a human approved
  groups: { id: string; phaseId: number; changeIds: string[]; message: string }[];
  prBody: string;
}
```

It's refused unless:
- the stack has the code the human approved (a clean rebase is fine; see [Rebase](data-model.md#rebase));
- every group has a message and there's a PR body;
- no thread is `open` or `proposed`.

It reuses the approved round's checks, or reruns them if the stack was rebased. Reviewers comment on the messages and the PR body with
`final` and `pr_body` locations (see [Review submissions](data-model.md#review-submissions)). Code comments still work. Anything that
needs a code change goes back through a code round (`lr review create`). Threads on messages and the
PR body stay put during code rounds, and get re-anchored at the next final round.

**What's applied is what a human approved.** A human can't approve a final round if the drafts have
changed since it opened. `lr final apply` refuses if they've changed since the approval, if a thread
is open, or if the code changed. After a clean rebase, it reruns the checks first.

**`lr final apply`:**
1. Records the jj operation as the undo point.
2. Squashes each group into its last change with its message. The last change keeps its change id
   and the phase's bookmark.
3. Checks that the new top of the stack has exactly the tree of the old top.
4. On any failure, it runs `jj op restore` back to the undo point and reports the error. On success,
   it records the apply (`final_applies`) and marks the feature `done`.

Bookmarks are kept. Pushing and opening the PR are left to the developer, or to an agent they ask.
