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

The repo key is a hash of the root path, so moving a repo breaks the link. `lr repo relink <path>`
repairs it: it updates `repo.json` and renames the key directory.

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
  jjOpId: string; // operation id at snapshot time
  planVersion: number;
  base: { commitId: string };
  changes: ChangeSnapshot[]; // ordered base → tip, linear stack only (v1)
  // closed = reviewed, then replaced by the next round; superseded = replaced before anyone
  // reviewed it (or by a rebase mid-review)
  status: "open" | "closed" | "superseded";
  verdict: "changes_requested" | "approved" | null; // set by a human's review
  rebases: string[]; // RebaseEvent ids since the previous round
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

Change ids survive a rebase, so anchors and phase membership are unaffected. What breaks is
anything keyed on commit ids or tree diffs:

- **"What changed since last round."** A tree diff of the old and new commit includes everything
  that landed on trunk in between. The review view uses `jj interdiff` instead, which rebases the
  old commit onto the new parent before diffing, so only the change's own patch edits show up.
  (Verified on jj 0.45: after a rebase onto a trunk commit that touched the same file, `jj diff`
  shows the trunk line and `jj interdiff` is empty.)
- **Checks.** Every check run is stale, because every commit id changed.
- **Conflicts.** A rebase can leave changes conflicted, and those have to be resolved before the
  next round.

`lr rebase [--onto <revset>]` handles this explicitly. It runs `jj rebase` for the stack (or adopts
a rebase that already happened, if the base moved), records a `RebaseEvent`, marks checks stale,
re-anchors threads, and reports any conflicted changes. If a round is open, it marks that round
`superseded` and opens round N+1: draft reviews move to the new round, and a submit against the
superseded round is rejected with a pointer to the new one. `lr review create` also detects a moved
base that `lr rebase` didn't record, and handles it the same way (with a warning).

```ts
interface RebaseEvent {
  id: string;
  fromBase: string; // commit ids
  toBase: string;
  onto: string; // revset as given
  jjOpBefore: string; // undo point
  jjOpAfter: string;
  conflicted: string[]; // change ids left conflicted
  by: Actor;
  at: string;
}
```

### Checks

Defined in `<repo>/.local-review.toml`:

```toml
setup = "bun install --frozen-lockfile"   # optional; runs once per commit before its checks

[[checks]]
name = "test"
run = "bun test"
at = "bookmarks"        # "tip" (default) | "bookmarks" | "changes"
timeout = "10m"         # default 10m
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
  anchor: Anchor;
  severity?: "blocking" | "suggestion" | "nit" | "question";
  status: "proposed" | "open" | "addressed" | "resolved" | "dismissed";
  anchorState: "current" | "moved" | "outdated"; // recomputed each round
  reviewId?: string; // the review it was created in (comments only)
  createdBy: Actor;
  createdInRound: number | null; // null for notes left during implementation
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
- Notes start `resolved`. A reviewer reply reopens a note as `open`.

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
  | { kind: "final"; groupId: string; lines?: [number, number] } // squashed-commit message
  | { kind: "pr_body"; lines?: [number, number] }
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

(`final` and `pr_body` anchors arrive with finalization.)

**Re-anchoring (per new round, per thread)**

1. Find `changeId` in the new snapshot. If it's gone, follow `jj evolog` / predecessors to see
   whether it was squashed into another change. If nothing is found → `outdated`.
2. Same `commitId` → `current` (fast path; after a rebase this never matches).
3. Otherwise, diff `path` between the old and new commit and map `lines` through the hunks.
   Untouched lines → `current` if their line numbers didn't change, `moved` if they did (update
   `lines`, keep the original in history). Touched lines → `outdated`: rendered against the original
   snippet, the way GitHub shows "outdated". Using a tree diff here, not an interdiff, is deliberate:
   if trunk shifted or edited the lines, the anchor really did move or go stale.
4. Fallback: an exact `snippet` search in the new file.

Author notes follow the same process. Agents leave notes on changes that are still being edited, so
their anchors are re-mapped at every `lr review create`.

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
    { "change": "kxqp", "message": true, "lines": 1, "severity": "nit", "body": "Imperative." }
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

### Squash plan

```ts
interface SquashPlan {
  round: number;
  groups: FinalCommit[]; // ordered; each group's changes must be contiguous
}

interface FinalCommit {
  id: string;
  phaseId: number;
  changeIds: string[];
  message: {
    draft: string | null; // composed by the agent from member messages + guidelines
    editedBy?: Actor;
    approved: boolean;
  };
}
```

By default there is one group per phase. In the UI, the developer toggles a "cut" between adjacent
changes in a phase to split it. Moving changes between phases and reordering are out of scope for
v1. The diff of a group is just the diff over its range, so the final review can preview the result
without squashing anything. `lr final apply` records the jj op id first (as the undo point), then
runs `jj squash` per group.

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
  context needed to act on them. `addressed` (waiting on the reviewer), `resolved`, `dismissed`,
  `proposed` and notes are left out.
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
one is a final `lr review create` "for a last look". Approved with nothing open means stop:
finalization isn't built yet. Once it is, the approved path will draft one message per squash group
(`lr final message <group> -F`), draft the PR body (`lr final pr-body -F`), and run
`lr review create --final`.

## 5. Agent-facing CLI surface (sketch)

These are the only write paths into the model, so it's worth listing them now:

| Command                                                                  | Who            | Effect                                                                        |
| ------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------- |
| `lr feature start <slug> [--base <revset>]`                              | author agent   | create feature                                                                |
| `lr plan submit\|revise -F <file>`                                       | author agent   | new plan version (validates frontmatter)                                      |
| `lr note <change> <path>:<a>-<b> "<text>"`                               | author agent   | author note (was `TEMPORAL`)                                                  |
| `lr review create [--final] [--allow-failing]`                           | author agent   | snapshot + checks; if a check fails, it exits non-zero and no round is opened |
| `lr review submit [-F <review.json>] [--verdict] [-m] [--round]`          | reviewer       | whole review, all comments at once (see Review submissions)                   |
| `lr handoff [--round] [--json]`                                          | author agent   | read the handoff                                                              |
| `lr reply <thread> [--addressed\|--resolve\|--dismiss\|--reopen\|--accept] "<text>"` | anyone | thread entry / status (see Thread)                                    |
| `lr threads [--status <s,…>\|--all]`                                     | anyone         | list threads                                                                  |
| `lr final message <group> -F` · `lr final pr-body -F` · `lr final apply` | author agent   | finalization                                                                  |
| `lr status [--json]`                                                     | anyone         | feature state + what's expected next                                          |
| `lr rebase [--onto <revset>]`                                            | anyone         | rebase the stack (or adopt one already done); see Rebase                      |
| `lr feature clean <slug> [--purge]`                                      | developer      | clean up a done/abandoned feature (see below)                                 |
| `lr repo relink <path>`                                                  | developer      | repair the repo key after the repo moves                                      |

`lr feature clean` deletes phase bookmarks that still point where `lr` left them. Any bookmark that
has moved since is skipped with a warning. It also forgets the jj workspaces and removes their
directories. Review state is kept for history unless `--purge` is passed.

## 6. Decisions log

- **jj only.** Colocated git repos should work, but only through jj.
- **Bookmarks after `final apply`:** kept. `lr feature clean` removes them later.
- **Rebases:** handled explicitly by `lr rebase`. Anchors survive because they're keyed on change
  ids; the review view uses interdiffs.
- **Repo moves:** `lr repo relink`.
- **Notes during implementation:** re-anchored at every `lr review create`.

## 7. Open questions

_None yet._
