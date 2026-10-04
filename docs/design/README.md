# local-review design

How lr models a feature's review, and why. [Using lr](../usage.md) covers the commands from the
outside; these docs are for changing lr. Update them in the same change when behavior diverges.

- [Data model](data-model.md): actors, features, plans, rounds, reviews, threads, anchors and
  re-anchoring, review files, and rebasing.
- [Checks](checks.md): where and how checks run, caching, timeouts, and signals.
- [Finalization](finalization.md): squash groups, drafts, final rounds, and `lr final apply`.
- [Handoff](handoff.md): what `lr handoff` gives the author agent.
- [CLI](cli.md): every command that writes, who runs it, and the housekeeping ones.
- [Claude Code integration](claude-code.md): the plugin's hooks.
- [Web UI](web-ui.md): `lr ui`, its API, and its security.
- [Decisions](decisions.md): choices worth not relitigating.

## Lifecycle

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
  **reviews** (agent or human) attach to a round. lr doesn't order reviewers; agents first, then
  the developer, is a convention of the plugin's skills.
- **Threads** live on the feature, not the round, so they carry across rounds. They get re-anchored
  onto each new snapshot.
- A round's **verdict** comes from the human review: `changes_requested` → revise loop; `approved`
  with open threads → revise, then finalize; `approved` with no open threads → finalize directly.

## Storage

```
~/.local-review/                      # or $LOCAL_REVIEW_HOME
  <repo-key>/                         # <dirname>-<6-char hash of repo root path>
    repo.json                         # { root, createdAt }
    ui.json                           # the running lr ui: pid, port, token (mode 0600)
    sessions/<session id>.json        # the stack as each Claude Code session found it
    state.db                          # SQLite (WAL), one per repo: features, plans, rounds, reviews,
                                      #   threads, checks
    <feature>/
      plan/v1.md, v2.md, …            # plan versions (human/agent-authored markdown)
      rounds/<n>/patches/<change>.patch
      checks/<run-id>.log             # check logs (runs are keyed by commit, not round)
      final/messages/<group>.md       # final commit message drafts
      final/pr.md                     # PR body draft
      workspaces/checks/              # jj workspace `lr-<feature>-checks`, where checks run
      workspaces/checks.lock          # held while a process runs checks there
<repo>/.local-review.toml             # committed with the repo: checks, and final, review, ui settings
```

**Why one database per repo.** Listing features and cross-feature queries stay a single query.
Feature directories only hold files.

**Why SQLite for state.** The CLI (called by the implementing agent), a reviewing agent, and the
web UI's server can all write during the same round. SQLite transactions make that safe without
inventing locking. Anything a person or agent writes as prose (plans, PR body) stays a plain file.
Logs and patches stay plain files too.

The repo key is a hash of the root path, so moving a repo breaks the link: lr finds no history at
the new path. `lr repo relink [<old path>]`, run in the moved repo, repairs it (see [CLI](cli.md#lr-repo-relink)).

**Why cache patches.** Each round records the jj operation id, so `jj --at-op` can reconstruct it.
But `jj op abandon` / `jj util gc` can drop old commits, and patches are cheap insurance for
interdiffs.
