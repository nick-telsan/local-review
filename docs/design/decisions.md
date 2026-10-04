# Decisions

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
- **The UI is a local web app, served by lr, not a desktop app.** All of lr is TypeScript on Bun, so a
  desktop shell (Electron, Tauri) would still run lr as a sidecar, and add signing, packaging, and
  updates. The browser gives deep links and tabs for free. The page is part of lr's source
  (`src/web/`), built into the same binary.
- **The UI's diff view is our own,** not a library's: lr's model (a stack of changes, threads that
  move between rounds, comments on messages) doesn't fit general-purpose diff components.
- **Re-anchoring state is relative to where the comment was made,** not the previous round, so
  "moved" always means "not where you left it". Outdated threads keep trying from their last good
  round rather than being dropped.
