# Data model

TypeScript notation for readability. On disk, these are SQLite rows, with JSON columns where the
data is nested.

## Actor

```ts
interface Actor {
  kind: "human" | "agent";
  name: string; // "nick", "claude-code", "codex"
}
```

Who's acting comes from `--as`, then `$LR_ACTOR`. Without either, lr checks whether a coding agent
runs it (`$AI_AGENT`, or `CLAUDECODE=1` for Claude Code) and records that agent. Only outside any
agent does it fall back to the OS user as a human. An agent that forgets `--as` can't record a
human's verdict. The Claude Code plugin also asks the developer before an agent claims to be a
human (see [Claude Code integration](claude-code.md)).

## Feature

```ts
interface Feature {
  slug: string; // "auth-refresh" — also the default bookmark prefix
  title: string;
  base: { revset: string }; // e.g. "trunk()"; resolved to a commit per round
  status:
    | "planning"
    | "implementing"
    | "in_review"
    | "revising"
    | "finalizing"
    | "final_review"
    | "approved" // final round approved; `lr final apply` is next
    | "done"
    | "abandoned";
  currentPlanVersion: number;
  createdAt: string;
}
```

`lr feature start` resolves the base once, to catch a base that would sweep in commits that aren't
the feature's: one below bookmarks that `@` builds on. That's the usual mistake, since jj's default
`trunk()` finds only a remote's `main`, `master` or `trunk`, and in a repo with no remote it's the
root commit. With the default base it's an error that names the nearest such bookmark to pass as
`--base`. A base given by name (even `--base 'trunk()'`) is taken as meant, with a warning. A
default base that's the root commit with no bookmarks in the way (a new repo) only warns.

## Plan

The plan is markdown with YAML frontmatter. The frontmatter holds the parts the tool needs to
understand: phases, their bookmarks, and tasks. The body is freeform.

```md
---
phases:
  - id: 1
    title: Schema + migration
    bookmark: auth-refresh/1-schema
    done_when: migrations apply cleanly; `bun test db` passes
    tasks:
      - { id: "1.1", title: Add refresh_tokens table }
      - { id: "1.2", title: Backfill existing sessions }
  - id: 2
    title: Token rotation
    bookmark: auth-refresh/2-rotation
    done_when: all checks pass
    tasks:
      - { id: "2.1", title: Rotate on use }
---

# Refresh token rotation

Narrative, context, decisions, risks…
```

```ts
interface PlanVersion {
  version: number;
  path: string; // plan/v2.md
  respondsToRound: number | null; // the round a revised plan answers; null for the first
  createdBy: Actor;
  createdAt: string;
}
```

Commits link to tasks through a jj trailer in the description: `Plan-Task: 1.1`. A change can name
several (`Plan-Task: 1.1, 1.2`, or one trailer each; the key is matched without case). This is
optional; the UI uses it to show plan-vs-implementation coverage (see [Web UI](web-ui.md)). Once any change in a
code round names a task, `lr review create` (as warnings; they never block a round), `lr status`,
and `lr handoff` list the **plan gaps**: tasks no change names,
task ids the plan doesn't have, and changes that name no task. Until then there's nothing to
measure, so they say nothing. Final rounds skip it, since their code is already approved.

## Round (snapshot)

```ts
interface Round {
  n: number;
  kind: "code" | "final"; // a final round reviews the squash groups and messages (see [Finalization](finalization.md))
  jjOpId: string; // operation id at snapshot time
  planVersion: number;
  base: { commitId: string };
  changes: ChangeSnapshot[]; // ordered base → tip, linear stack only (v1)
  // closed = reviewed, then replaced by the next round; superseded = replaced before anyone
  // reviewed it
  status: "open" | "closed" | "superseded";
  verdict: "changes_requested" | "approved" | null; // set by a human's review
  final: FinalSnapshot | null; // final rounds only
  createdBy: Actor;
  createdAt: string;
}

interface ChangeSnapshot {
  changeId: string; // stable across rewrites — the anchor for everything
  commitId: string; // this round's version
  description: string;
  trailers: Record<string, string[]>;
  phaseId: number | null; // null = past the last bookmark (warned about at create)
  bookmarks: string[]; // bookmarks pointing at this change
  conflicted: boolean; // jj first-class conflicts count as a failing check
  empty: boolean;
  stats: { files: number; added: number; removed: number };
}
```

A change's phase is the first phase bookmark at or after it in stack order.

## Rebase

Change ids survive a rebase, so anchors, phase membership, and squash groups are unaffected. What
changes is every commit id, and with them the trees:

- **"What changed since last round."** A tree diff of a change's old and new commit includes
  everything that landed on the base in between. `jj interdiff` rebases the old commit onto the new
  parent before comparing, so only edits to the change's own patch show up. (Verified on jj 0.45:
  after a rebase onto a trunk commit that touched the same file, `jj diff` shows the trunk line and
  `jj interdiff` is empty.)
- **Checks.** A check run is keyed on the commit id, so none carries over.
- **Conflicts.** A rebase can leave changes conflicted, and those have to be resolved before the
  next round.

lr keeps no rebase state of its own, so a plain `jj rebase` works as well as `lr rebase`:

- **Rounds are snapshots.** A round keeps the commits it was taken from, and those stay readable
  after a rebase hides them. An open round stays open, and reviews of it still count. The next
  `lr review create` picks up the rebased stack like any other edit: it reruns the checks and
  re-anchors threads, mapping lines through the base's changes.
- **An approval survives a clean rebase.** Finalizing needs the code a human approved, which is
  judged change by change (`codeChanges`). The change ids and phases must be the same, and in
  order. Each change must be unconflicted, with the same message and no file in
  `jj interdiff --name-only`. A conflict always counts as a change, even though interdiff can't see
  one: a change that conflicts the same way on both sides comes out empty. If the commits were
  rewritten but the code is the same, `lr review create --final` and `lr final apply` rerun the
  checks on the new commits first, and refuse if any fail. Resolving a conflict changes the code,
  so it goes back through a code round.

`lr rebase [--onto <revset>]` is the convenient way to do it. It resolves the target to one commit,
which has to be outside the stack, and runs `jj rebase --source <first change> --onto <commit>`.
Bookmarks and the working copy come along. Then it reports the conflicted changes, the undo point,
and what to do next for the feature's status. `--onto` also makes the revset the feature's base from
then on, e.g. to move a stacked feature onto trunk once the feature below it lands. Rebasing is
never automatic. The author does it when the developer asks, or when the stack needs something that
landed on the base.

## Review

```ts
interface Review {
  id: string;
  round: number;
  reviewer: Actor;
  state: "draft" | "submitted"; // always "submitted": drafts are kept apart until then (below)
  verdict: "changes_requested" | "approved" | null; // null = comments only
  body: string | null; // markdown summary
  createdAt: string;
  submittedAt: string | null;
}
```

A human's verdict becomes the round's verdict. An agent's verdict is recorded, but it doesn't
decide the round. A reviewer can submit more than one review per round.

"Approved with comments" is never stored. It's derived: `verdict = approved` and at least one
thread is `open`.

**Drafts.** In the UI, a reviewer's comments collect in a draft (`review_drafts`, one per reviewer
and round) until they submit it with a verdict and summary. A draft is stored as a review file
(the same JSON `lr review submit -F` takes), plus where each comment shows. Each comment is checked
against the round's snapshot when it's added, and submitting goes through `lr review submit`'s own
validation and recording. Nobody else sees a draft: not the handoff, `lr threads`, or `lr status`.
A draft on a round that's superseded before it's submitted can only be discarded; its comments
aren't carried to the new round.

## Thread

A thread is used for review comments and also for **author notes**, which stand in for explanatory
comments in the code.

```ts
interface Thread {
  id: number; // per-feature sequence; rendered as #12
  kind: "comment" | "note";
  anchor: Anchor; // where it points now; when outdated, the last place it was found
  anchorRound: number | null; // the round whose snapshot `anchor` refers to; null for a new note
  anchorStack: { baseCommitId: string; changes: { changeId: string; commitId: string }[] } | null;
  // ^ for a note no round has picked up yet: the stack `anchor` refers to
  anchorState: "current" | "moved" | "outdated"; // relative to originalAnchor; see [Re-anchoring](#re-anchoring)
  originalAnchor: Anchor; // where the comment was made; never changes
  severity?: "blocking" | "suggestion" | "nit" | "question";
  status: "proposed" | "open" | "addressed" | "resolved" | "dismissed";
  reviewId?: string; // the review it was created in (comments only)
  createdBy: Actor;
  createdInRound: number | null; // null for notes
  entries: Entry[];
}

interface Entry {
  id: string;
  author: Actor;
  body: string; // markdown
  suggestion?: { text: string }; // replaces the anchor's line range (code or commit message)
  statusChange?: { from: Thread["status"]; to: Thread["status"] };
  round: number | null;
  createdAt: string;
}
```

### Status transitions

```
proposed ──(human accepts)──► open ──(fixer: --addressed)──► addressed ──(reviewer)──► resolved
   │                           ▲                                 │
   └─(human dismisses)─► dismissed   └──────(reviewer reopens)───┘
```

- `proposed` exists only when policy says agent-reviewer comments need human triage. Otherwise
  agent comments start `open`.
- Only reviewers move threads to `resolved` / `dismissed`. The fixing agent can only mark
  `addressed`, or reply without changing status (that's how it pushes back).

All of these go through `lr reply <thread> [<action>] [<message>]`. The message can come from a
file instead, or stdin with `-F -`:

| Action        | From                              | To          | Who                                      |
| ------------- | --------------------------------- | ----------- | ---------------------------------------- |
| (none)        | any                               | (unchanged) | anyone; a message is required            |
| `--addressed` | `open`                            | `addressed` | anyone; a message saying what changed    |
| `--resolve`   | `open`, `addressed`               | `resolved`  | a human, or the agent that raised it     |
| `--dismiss`   | `proposed`, `open`, `addressed`   | `dismissed` | a human, or the agent that raised it     |
| `--reopen`    | `addressed`, `resolved`, `dismissed` | `open`   | a human, or the agent that raised it     |
| `--accept`    | `proposed`                        | `open`      | a human                                  |

`lr threads` lists unsettled threads (`proposed`, `open`, `addressed`), or `--status a,b` or `--all`.
`--notes` lists notes only, in any status unless `--status` narrows it.

### Notes

A note is the author annotating their own diff for reviewers, in place of an explanatory comment in
the code. Notes can't leak into the PR, and there's nothing to clean up at finalization.

```sh
lr note <change> "<text>"                             # on the change
lr note <change> <path>:<line>[-<line>] [--old] "<text>"   # on lines of the diff it introduces
```

- `<change>` is a change id or prefix, or a revset that resolves to one change in the stack (`@-`,
  a bookmark). `lr check <change>` on the live stack takes the same. A round's changes are named
  by change id only, since a revset would resolve against the repo now, not the round.
- A note is written against the stack as it is now, not a round's snapshot, since it's usually
  written while a phase is still in progress. Before any phase bookmark exists, the stack runs from
  the base up to `@`. The location is checked like a review comment's. The note records the stack's
  change and commit ids (`anchorStack`), and the next round places it from there (see [Re-anchoring](#re-anchoring)).
- Notes start `resolved`, so they don't count as open work.
- A reply from anyone other than the note's author reopens it as `open`, since it's a question or
  comment for the author. From then on it's like a review comment: it shows up in the handoff, and
  whoever reopened it (or a human) resolves it. Anyone but the author can also `--reopen` a note
  explicitly. The author's own replies leave it alone.

## Anchor

```ts
type RevRef = { changeId: string } | "base";

type Anchor =
  | { kind: "feature" }
  | { kind: "phase"; phaseId: number }
  | { kind: "change"; changeId: string } // general comment on a commit
  | {
      kind: "message"; // commit message
      changeId: string;
      commitId: string; // commit whose description was commented on
      lines: [number, number] | null; // null = the whole message
      snippet: string[]; // the commented lines (or the whole message)
    }
  | { kind: "final"; groupId: string; lines: [number, number] | null; snippet: string[] } // final round
  | { kind: "pr_body"; lines: [number, number] | null; snippet: string[] } // final round
  | { kind: "plan"; version: number; lines: [number, number] | null; snippet: string[] }
  | {
      kind: "code";
      view: { from: RevRef; to: RevRef }; // the diff the comment was made in
      changeId: string; // the change the line is attributed to
      commitId: string; // commit of that change when the comment was made
      path: string;
      side: "old" | "new";
      lines: [number, number];
      snippet: string[]; // exact line contents at creation
    };
```

`view` records which diff the reviewer was looking at: per-commit (`parent..change`), per-bookmark
(`prev bookmark..bookmark`), or everything (`base..tip`). `changeId` is where the fix belongs. For
new-side lines in a multi-change view, attribution comes from `jj file annotate` at `view.to`: the
latest change in the view that touched any of the commented lines. For old-side lines, and for
lines no change in the view touched, it falls back to `view.to`'s change.

`final` and `pr_body` anchors point into a final round's frozen messages and PR body. `plan`
anchors point into the plan file (frontmatter included, so line numbers match the file) of the
version the round was taken against.

### Re-anchoring

`lr review create` carries every unsettled thread (`proposed`, `open`, `addressed`) from its
`anchorRound` onto the new round. Resolved and dismissed threads stay where they were. If one is
reopened, the next round carries it from there, however many rounds back that is.

The state is always relative to `originalAnchor`:

- **current:** the same change and lines as when the comment was made.
- **moved:** the same content, on other lines or in another change.
- **outdated:** the content changed, or its change or phase is gone. The thread keeps its last good
  `anchor` and `anchorRound`. The handoff shows it "as it was then". Later rounds keep trying from
  there, so a revert brings it back.

Per anchor kind:

1. **Changes are followed by change id.** If one is missing from the new snapshot, it's looked up in
   `jj evolog` of every new change, which includes the history of changes squashed into it. If it
   isn't found there, it was abandoned, and the thread becomes `outdated`.
2. **Code.** The view keeps its endpoints, followed as above. A start that's gone, or no longer
   before the end, becomes the end's parent. The commented lines are mapped through
   `jj diff --git --context=0` between the old and new revision of the file, or skipped when the
   commit id is the same. Lines no hunk touches shift by the hunks above them. Any hunk inside the
   range (an insertion between two of the lines included) makes it outdated. This uses a tree diff,
   not an interdiff, on purpose: if trunk edited the lines, the anchor really did go stale.
3. **Snippet fallback.** When the diff touches the lines (or the old commit can't be read, e.g.
   after `jj util gc`), an exact match of `snippet` that appears exactly once in the new file places
   the thread. That catches code that moved within its file.
4. **Renamed files** are followed when jj reports the rename between the old and new revision. jj
   detects renames by content similarity, so a file that was also edited heavily reads as a delete
   and an add, and its threads go `outdated`. A followed thread gets the new path, and its lines
   are mapped (or found by snippet) in the renamed file as above.
5. **Commit messages.** A whole-message comment goes outdated if the message changes at all. A
   line-range comment stays put if those lines are unchanged, or moves to a unique exact match of
   its snippet.
6. **The plan.** Plan comments move onto the new round's plan version, like message comments: a
   whole-plan comment goes outdated if the plan changed at all, and a line-range comment stays put
   or moves to a unique exact match of its snippet. So a revision that rewrites the commented text
   outdates the comment, which is usually what addressing it means.
7. **Phases** go outdated when the current plan no longer has them. **General** threads are always
   current.

Notes follow the same process, and resolved notes are carried too, because reviewers read them
next to the code. A note that no round has placed yet is mapped from its `anchorStack` rather than
a round's snapshot. If it goes outdated there, it keeps `anchorRound` null and tries again from the
same stack next time.

## Review submissions

`lr review submit -F <review.json>` (or `-F -` for stdin) records a whole review at once. This is the
path agents use. `--verdict` and `-m <body>` can stand in for the file, or override its fields.

```jsonc
{
  "verdict": "changes_requested",   // or "approved"; omit for comments only
  "body": "Summary for the author (markdown).",
  "comments": [
    // General comment on the feature.
    { "body": "Feature-flag the rotation." },
    // A phase, or one change (a unique prefix of its change id is enough).
    { "phase": 2, "body": "…" },
    { "change": "kxqp", "body": "…" },
    // Code in one change's diff. `lines` is a number or [first, last], 1-based.
    { "change": "kxqp", "path": "src/db.ts", "lines": [40, 41], "severity": "blocking",
      "body": "Both need NOT NULL.", "suggestion": "expires_at: timestamp().notNull(),\n…" },
    // Code in a phase's combined diff, or in the whole stack's (no change or phase).
    { "phase": 1, "path": "src/db.ts", "lines": 40, "body": "…" },
    { "path": "src/db.ts", "lines": 12, "side": "old", "body": "Why was this removed?" },
    // A commit message (the whole message, or specific lines).
    { "change": "kxqp", "message": true, "lines": 1, "severity": "nit", "body": "Imperative." },
    // Final rounds only: a final commit's message (by group id), or the PR body.
    { "final": "2a", "lines": 1, "body": "Say what rotates." },
    { "pr_body": true, "lines": [3, 4], "body": "Mention the backfill." },
    // The plan the round was taken against, whole or by lines of its file.
    { "plan": true, "lines": [20, 22], "body": "Why not hash the tokens now?" }
  ]
}
```

`severity` is `blocking`, `suggestion`, `nit` or `question`. It's optional. `side` defaults to
`new`.

Validation happens in two passes, and each reports every problem at once, so an agent can fix them
all in one go:

1. **Shape:** unknown fields (so typos like `line` are caught), types, and combinations that don't
   make sense. For example, `lines` without a `path` or `message`, or a `suggestion` without
   `lines`.
2. **Locations**, checked against the round's pinned jj operation, so it doesn't matter if the
   stack has been rewritten since: the change is in the round, the phase has changes, the file
   exists on that side of the view, and the lines are within the file or message.

Nothing is recorded unless every comment resolves. The review goes on the latest round, or on
`--round <n>`. Superseded and closed rounds are rejected, and a superseded round's error points to
the current one. Each comment becomes a thread (numbered per feature) whose first entry is the
comment. Agent comments start `proposed` when `[review] triage_agent_comments = true` is set in
`.local-review.toml`, and `open` otherwise.
