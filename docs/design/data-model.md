# local-review: data model & handoff format

Status: draft v1 — 2026-09-27

Working CLI name in this doc: `lr`.

## 1. Lifecycle

```
            ┌──────────────── revise (plan vN+1, amend changes) ◄───────────────┐
            ▼                                                                   │
plan ──► implement ──► lr review create ──► round N ──► reviews ──► handoff ────┤ changes requested
 (A)        (B)        (snapshot + checks)             (agent, human)           │
                                                                                └─► approved
                                                                                     │
                     done ◄── lr final apply ◄── final review ◄── finalize (C) ◄─────┘
                               (jj squash)       (messages, PR body)  (+ revise if comments)
```

- A **feature** is the unit of work: one plan, one stack of changes, many review rounds.
- A **round** is an immutable snapshot of the stack taken by `lr review create`. Any number of
  **reviews** (agent or human) attach to a round. Ordering between reviewers (agent first, parallel,
  etc.) is a config policy, not part of the model.
- **Threads** live on the feature, not the round, so they carry across rounds. They get re-anchored
  onto each new snapshot.
- A round's **verdict** comes from the human review: `changes_requested` → revise loop; `approved`
  with open threads → revise, then finalize; `approved` with no open threads → finalize directly.

## 2. Storage

```
~/.local-review/
  config.toml                         # global defaults
  <repo-key>/                         # <dirname>-<6-char hash of repo root path>
    repo.json                         # { root, createdAt }
    state.db                          # SQLite (WAL), one per repo: features, plans, rounds, reviews,
                                      #   threads, checks
    <feature>/
      plan/v1.md, v2.md, …            # plan versions (human/agent-authored markdown)
      rounds/<n>/patches/<change>.patch
      checks/<run-id>.log             # check logs (runs are keyed by commit, not round)
      final/messages/<group>.md       # final commit message drafts
      final/pr.md                     # PR body draft
      workspaces/checks/              # jj workspace `lr-<feature>-checks`, where checks run
<repo>/.local-review.toml             # team-shareable: checks, bookmark naming, squash defaults
```

**Why one database per repo.** Listing features and cross-feature queries stay a single query.
Feature directories only hold files.

**Why SQLite for state.** The CLI (called by the implementing agent), a reviewing agent, and the
desktop app can all write during the same round. SQLite transactions make that safe without
inventing locking. Anything a person or agent writes as prose (plans, PR body) stays a plain file.
Logs and patches stay plain files too.

The repo key is a hash of the root path, so moving a repo breaks the link: lr finds no history at
the new path. `lr repo relink [<old path>]`, run in the moved repo, repairs it (see CLI).

**Why cache patches.** Each round records the jj operation id, so `jj --at-op` can reconstruct it.
But `jj op abandon` / `jj util gc` can drop old commits, and patches are cheap insurance for
interdiffs.

## 3. Entities

TypeScript notation for readability. On disk, these are SQLite rows, with JSON columns where the
data is nested.

### Actor

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
human (see Claude Code integration).

### Feature

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

### Plan

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
  respondsToRound?: number; // set for A', A'', …
  createdBy: Actor;
  createdAt: string;
}
```

Commits link to tasks through a jj trailer in the description: `Plan-Task: 1.1`. This is optional;
the UI uses it to show plan-vs-implementation coverage. (Verified: `jj log -T trailers` works on
jj 0.45.)

### Round (snapshot)

```ts
interface Round {
  n: number;
  kind: "code" | "final"; // a final round reviews the squash groups and messages (see Finalization)
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

### Rebase

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

### Checks

Defined in `<repo>/.local-review.toml`:

```toml
setup = "bun install --frozen-lockfile"   # optional; runs once per commit before its checks
setup_kill_after = "30s"                  # default 30s; like kill_after, for setup

[[checks]]
name = "test"
run = "bun test"
at = "bookmarks"        # "tip" (default) | "bookmarks" | "changes"
timeout = "10m"         # default 10m
kill_after = "30s"      # default 30s: time to shut down after SIGTERM, before SIGKILL
```

```ts
interface CheckRun {
  id: string;
  check: string;
  command: string; // part of the cache key: editing a check's command invalidates old passes
  changeId: string;
  commitId: string; // stale if ≠ the change's commit in the latest round
  trigger: "auto" | "manual"; // manual = a reviewer ran it on a specific commit
  status: "pending" | "running" | "pass" | "fail" | "error" | "skipped";
  exitCode?: number;
  logPath: string;
  startedAt?: string;
  finishedAt?: string;
}
```

Check runs belong to a commit, not a round. A `round_checks` table links each round to the runs it
used. Before running a check, `lr review create` looks for an earlier passing run with the same
check, command and commit id, and reuses it. So when an agent fixes one failing phase, only the
commits that changed get re-checked.

Every check runs in the feature's jj workspace (`workspaces/checks`), including checks at the tip,
so the developer's working copy is never touched. Before each commit the workspace is restored,
which discards anything a previous check wrote. That keeps the workspace commit empty, and jj
abandons it when the workspace moves on. Checks get `LR_CHECK`, `LR_CHANGE_ID` and `LR_COMMIT_ID`
in their environment.

If a check fails, or a change is conflicted (conflicts propagate to descendants), no round is
opened. The runs are still recorded, so their logs are available for the fix.

Each check (and setup) runs in its own process group, so stopping it stops everything it started,
not just the shell. A check past its timeout gets SIGTERM, then SIGKILL after `kill_after`; the run
is an `error`. Anything a check leaves running after it exits (a background server, say) is stopped
the same way, without changing its result, so nothing touches the workspace after lr moves on. If
it doesn't exit within half a second, lr says it's waiting and for how long.

The 30-second default is for test suites that tear down databases or containers. Those usually
belong to the Docker daemon, not the check's process group, so only the suite's own teardown can
stop them, and a SIGKILL mid-teardown leaves them running. Set `kill_after` higher for suites that
need longer; waiting forever isn't an option, since a hung teardown would hang the round.

The group isn't in the terminal's foreground group, so lr passes SIGINT, SIGTERM and SIGHUP on to
the running check. A second one, or one while lr is waiting for a check to stop, kills it. The run
is recorded as an `error`, no round is opened, and lr exits as an interrupted shell would (130 for
Ctrl-C).

### Review

```ts
interface Review {
  id: string;
  round: number;
  reviewer: Actor;
  state: "draft" | "submitted"; // threads in a draft review are invisible to others until submit
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

### Thread

A thread is used for review comments and also for **author notes** (the replacement for inline
`TEMPORAL` comments).

```ts
interface Thread {
  id: number; // per-feature sequence; rendered as #12
  kind: "comment" | "note";
  anchor: Anchor; // where it points now; when outdated, the last place it was found
  anchorRound: number | null; // the round whose snapshot `anchor` refers to; null for a new note
  anchorStack: { baseCommitId: string; changes: { changeId: string; commitId: string }[] } | null;
  // ^ for a note no round has picked up yet: the stack `anchor` refers to
  anchorState: "current" | "moved" | "outdated"; // relative to originalAnchor; see Re-anchoring
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

**Status transitions**

```
proposed ──(human accepts)──► open ──(fixer: --addressed)──► addressed ──(reviewer)──► resolved
   │                           ▲                                 │
   └─(human dismisses)─► dismissed   └──────(reviewer reopens)───┘
```

- `proposed` exists only when policy says agent-reviewer comments need human triage. Otherwise
  agent comments start `open`.
- Only reviewers move threads to `resolved` / `dismissed`. The fixing agent can only mark
  `addressed`, or reply without changing status (that's how it pushes back).

All of these go through `lr reply <thread> [<action>] [<message>]`:

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

**Notes**

A note is the author annotating their own diff for reviewers, in place of an explanatory comment in
the code. Notes can't leak into the PR, and there's nothing to clean up at finalization.

```sh
lr note <change> "<text>"                             # on the change
lr note <change> <path>:<line>[-<line>] [--old] "<text>"   # on lines of the diff it introduces
```

- A note is written against the stack as it is now, not a round's snapshot, since it's usually
  written while a phase is still in progress. Before any phase bookmark exists, the stack runs from
  the base up to `@`. The location is checked like a review comment's. The note records the stack's
  change and commit ids (`anchorStack`), and the next round places it from there (see Re-anchoring).
- Notes start `resolved`, so they don't count as open work.
- A reply from anyone other than the note's author reopens it as `open`, since it's a question or
  comment for the author. From then on it's like a review comment: it shows up in the handoff, and
  whoever reopened it (or a human) resolves it. Anyone but the author can also `--reopen` a note
  explicitly. The author's own replies leave it alone.

### Anchor

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

`final` and `pr_body` anchors point into a final round's frozen messages and PR body.

**Re-anchoring**

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
6. **Phases** go outdated when the current plan no longer has them. **General** threads are always
   current.

Notes follow the same process, and resolved notes are carried too, because reviewers read them
next to the code. A note that no round has placed yet is mapped from its `anchorStack` rather than
a round's snapshot. If it goes outdated there, it keeps `anchorRound` null and tries again from the
same stack next time.

### Review submissions

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
    { "pr_body": true, "lines": [3, 4], "body": "Mention the backfill." }
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

### Finalization

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
- the stack has the code the human approved (a clean rebase is fine; see Rebase);
- every group has a message and there's a PR body;
- no thread is `open` or `proposed`.

It reuses the approved round's checks, or reruns them if the stack was rebased. Reviewers comment on the messages and the PR body with
`final` and `pr_body` locations (see Review submissions). Code comments still work. Anything that
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

## 4. Handoff format

`lr handoff [--round N] [--json]`. Markdown is the default because agents read it best. `--json` returns
the same content as structured data. It's read-only, so the agent can re-read it whenever it wants.

**When there's something to hand off.** Only a human approves. A human's verdict on the round is
the verdict. Without one, the handoff is "changes requested (by agent reviewers)" if an agent asked
for changes or left open threads. That's the agent-reviews-first loop. Otherwise there's nothing to
hand off yet (no reviews, or agents approved and a human hasn't weighed in), and `lr handoff` exits
1 with the reason. `lr status` points at the handoff once it's ready. A human's verdict also moves
the feature to `revising` or `finalizing`.

Rules:

- Include every `open` thread on the feature, from any round (reopened ones included), with the
  context needed to act on them. They're shown where they were re-anchored to in the latest round.
  Outdated threads are marked, with the snippet as it was. `addressed` (waiting on the reviewer),
  `resolved`, `dismissed` and `proposed` threads are left out. That includes notes, unless
  someone reopened one.
- Group by where the fix goes: general → phase → change → file. The agent works change by change
  (`jj edit` / `jj squash --into`), so that's the useful order.
- Inline the code snippet and the full thread, so the agent doesn't need extra lookups to
  understand a comment.
- Always end with explicit next-step instructions that match the verdict.

Example (changes requested), exactly as rendered:

````md
# Review handoff: auth-refresh, round 2

**Verdict:** changes requested  
**Reviews:** agent:codex: approved · human:nick: changes requested  
**Checks:** ✗ test @ `vtzqlmsr` (fail): log at ~/.local-review/…/checks/0199….log  
**Plan:** v1 · 3 open thread(s) (2 blocking)

## Reviewer summary (human:nick)

> Schema looks right. Rotation has a race; see #14.

## General

### #9 · blocking

> **human:nick**: Rotation should be feature-flagged.

## Phase 1: Schema + migration (`auth-refresh/1-schema`)

### Change `kxqpmwyz` "Adds refresh_tokens table"

#### #13 · nit · commit message, line 1

```
Adds refresh_tokens table
```

> **human:nick**: Subject should be imperative: "Add…", not "Adds…".

#### #12 · blocking · `src/db/schema.ts:40-41` (new)

```ts
40 |   expires_at: timestamp(),
41 |   revoked: boolean(),
```

> **human:nick**: Both need `.notNull()`.
>
> Suggested:
>
> ```ts
> expires_at: timestamp().notNull(),
> revoked: boolean().notNull().default(false),
> ```
>
> **agent:claude-code** (marked addressed): Added in kxqpmwyz.
>
> **human:nick** (marked open): `revoked` still allows null.

## Next steps

1. Fix the failing checks listed above.
2. Write a revised plan that covers every open thread above, and says why for any you won't change: `lr plan revise -F <file>`.
3. Amend the changes the threads are on, in place (`jj edit <change>`, or `jj squash --into <change>`). Don't stack fixup commits unless the plan says to.
4. Reply to every thread: `lr reply <id> --addressed "<what changed>"`, or `lr reply <id> "<why not>"` to push back.
5. Run `lr review create` to open the next round.
````

When the verdict is `approved` and threads are open, the steps are the same, except that the last
one is a final `lr review create` "for a last look". Approved with nothing open means finalize: draft
one message per group (`lr final message <group> -F`) and the PR body (`lr final pr-body -F`),
then run `lr review create --final`. A final round's handoff is titled "final round N". It groups
threads under "Final commit messages" and "PR body". Its steps are to redraft, reply, and open the
next final round, or to run `lr final apply` once approved.

## 5. Agent-facing CLI surface (sketch)

These are the only write paths into the model, so it's worth listing them now:

| Command                                                                  | Who            | Effect                                                                        |
| ------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------- |
| `lr feature start <slug> [--base <revset>]`                              | author agent   | create feature                                                                |
| `lr plan submit\|revise -F <file>`                                       | author agent   | new plan version (validates frontmatter)                                      |
| `lr note <change> [<path>:<a>[-<b>] [--old]] "<text>"`                   | author agent   | a note for reviewers on your own change (see Notes)                           |
| `lr review create [--allow-failing] [--skip-checks]`                     | author agent   | snapshot + checks, then re-anchor threads; if a check fails, it exits non-zero and no round is opened |
| `lr review create --final`                                               | author agent   | a final round (see Finalization)                                              |
| `lr review submit [-F <review.json>] [--verdict] [-m] [--round]`          | reviewer       | whole review, all comments at once (see Review submissions)                   |
| `lr handoff [--round] [--json]`                                          | author agent   | read the handoff                                                              |
| `lr diff [<change>] [--from <n>] [--to <n>] [--name-only]`              | anyone         | what changed between rounds, change by change (see below)                     |
| `lr reply <thread> [--addressed\|--resolve\|--dismiss\|--reopen\|--accept] "<text>"` | anyone | thread entry / status (see Thread)                                    |
| `lr threads [--status <s,…>\|--all] [--notes]`                           | anyone         | list threads, or notes                                                        |
| `lr final show` · `lr final message <group> -F` · `lr final pr-body -F`  | author agent   | draft the final commits (see Finalization)                                    |
| `lr final cut <change> [--remove]`                                       | developer      | split a phase into more than one final commit                                 |
| `lr final apply`                                                         | anyone         | squash the stack as approved                                                  |
| `lr status [--json]`                                                     | anyone         | feature state + what's expected next                                          |
| `lr rebase [--onto <revset>]`                                            | anyone         | rebase the stack onto its base (`--onto`: a new base); see Rebase             |
| `lr hook session-start\|pre-tool-use\|stop`                              | Claude Code    | hook handlers; see Claude Code integration                                    |
| `lr feature abandon [<slug>]`                                            | human          | give up on a feature (history and commits are kept)                           |
| `lr feature clean [<slug>…] [--purge]`                                   | anyone; `--purge`: human | tidy up after finished features (see below)                         |
| `lr repo relink [<old path>]`                                            | developer      | bring review history along after the repo moves (see below)                   |

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

`lr diff` compares two rounds change by change: by default the latest round against the last one
the actor reviewed, or else the one before it. Each change is `added`, `removed` (abandoned, or
squashed into the change named), `changed`, or `unchanged`. A changed change's patch is
`jj interdiff --git` between its two commits, so a rebase alone changes nothing, and a message edit
shows as a `JJ-COMMIT-DESCRIPTION` file. A change that moved phases, or is conflicted, counts as
changed. If the earlier commit is gone (`jj util gc`), it shows the whole change and says so.

`lr repo relink` moves a repo's review history to where the repo is now. Without a path, it looks
for history whose repo is gone and whose latest rounds recorded commits this repo has; it relinks
the one match, and otherwise asks for the old path. Given a path, it refuses one that's still a jj
repo (a copy isn't a move), or whose rounds recorded none of this repo's commits. It renames the
key directory, points `repo.json` and the check log paths at the new place, and replaces the empty
state that any lr command run here before relinking left behind. It won't merge two histories.
Checks workspaces find their repo by a relative path, which the move broke, so relink forgets them
and removes their directories; the next check run makes new ones. Until the repo is relinked,
commands that find no features here say so when history for a gone repo of the same name exists.

### Claude Code integration

`plugin/` is a Claude Code plugin, listed by the marketplace at the repo root. It has two skills,
`lr-author` and `lr-review`, and three hooks. The skills and hooks also work installed on their own
(skills in `~/.claude/skills/`, hooks in `settings.json`), so each hook is a plain shell command
that calls `lr hook <event>` and does nothing if `lr` isn't on `PATH`. The logic lives in lr, where
it's tested.

- **SessionStart:** if the repo has lr state and one active feature, it prints the feature's status
  and next step, which becomes session context. It also records the stack as the session found it.
  Resume and compaction keep the same record.
- **PreToolUse (Bash):** if a command runs lr as a human (`--as human:…`, `--as <name>`,
  `LR_ACTOR=<human>`), it returns `ask` so the developer confirms.
- **Stop:** if the feature is `implementing` or `revising`, and the stack differs from both how the
  session found it and the latest round, it blocks the stop once (exit 2) with a reminder: open a
  round with `lr review create`, or say what's left. It fires once per stack state, and never while
  `stop_hook_active`. The plugin's `stop_reminder` option turns it off.

Session records live in `<repo-key>/sessions/<session id>.json`.

## 6. Decisions log

- **jj only.** Colocated git repos should work, but only through jj.
- **Bookmarks after `final apply`:** kept, for pushing. `lr feature clean` forgets them later,
  locally only: lr never deletes anything on a remote.
- **Abandoning is a human's call** (`lr feature abandon`), like approving.
- **Rebases leave no trace in lr's state.** `lr rebase` is a convenience over `jj rebase`, and lr
  treats both the same way. There's no rebase record: the undo point is in jj's operation log. A
  rebase doesn't supersede an open round, since the round's snapshot is still what its reviewers
  are reading.
- **An approval covers each change's own diff, not its commit id,** so a clean rebase keeps it. The
  checks run again on the rebased commits before anything is finalized.
- **Checks run in their own process group**, so a timeout can stop what a check started, not only
  its shell. The cost is that lr has to pass Ctrl-C on itself.
- **Repo moves:** `lr repo relink`, rather than a repo id stored in the repo. lr keeps nothing in
  the working copy, and matching on recorded commits finds the history without one.
- **Notes are anchored to the live stack,** because they're written mid-phase, before any round.
  They're re-anchored at every `lr review create`, resolved or not.
- **Replying to a note reopens it** (unless you wrote it). A question is the common case, and one
  that silently went nowhere would be worse than resolving a "thanks".
- **Final rounds, not a separate artifact:** the final review is a round of kind `final`, so reviews,
  threads, re-anchoring, and the handoff all work unchanged.
- **Drafts are files; approvals are snapshots.** The developer can edit drafts in their editor, and
  lr guarantees that what's applied is exactly what a human approved. It refuses an approval or an
  apply if the drafts drifted.
- **Squash into the last change:** it keeps the phase bookmark and change id, and jj verifies the
  tree is unchanged.
- **Agent by default inside agents:** lr defaults to the detected coding agent's identity rather
  than the OS user. Your own `!` commands inside Claude Code therefore need `--as <you>`.
- **The Stop reminder only fires for changes made in the session:** a session that didn't touch the
  stack isn't asked about it.
- **Re-anchoring state is relative to where the comment was made,** not the previous round, so
  "moved" always means "not where you left it". Outdated threads keep trying from their last good
  round rather than being dropped.

## 7. Open questions

_None yet._
