# Checks

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
  trigger: "auto" | "manual"; // manual = someone ran it with `lr check`
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
which discards anything a previous check wrote. That keeps the workspace commit empty. It's one
change for the workspace's life, described as lr's (`lr: where local-review runs checks for …`)
and moved with `jj rebase -r @`, so in `jj log` it doesn't read as a stray change of the
developer's. jj abandons an empty working-copy commit on `workspace forget` only when it has no
description, so lr abandons it first. Checks get `LR_CHECK`, `LR_CHANGE_ID` and `LR_COMMIT_ID`
in their environment.

If a check fails, or a change is conflicted (conflicts propagate to descendants), no round is
opened. The runs are still recorded, so their logs are available for the fix.

One process runs checks in a feature's workspace at a time, since two would check out over each
other. While one does, it holds `workspaces/checks.lock` (created exclusively, with its pid). A
second run says whose turn it is and waits, then looks at the cache again, so it reuses what the
first run passed. A lock whose process is gone (killed, or crashed) is taken over. Runs served
entirely from the cache don't need the workspace, and don't wait.

`lr check` runs checks by hand. By default it checks the stack as it is now (even before the phase
bookmarks exist), with the same targets `lr review create` would use, so an author can confirm a
fix first. Passing runs are cached the same way, so the next round reuses them. With `--round <n>`,
it checks that round's commits instead, and adds the runs to the round. A round shows the latest run
of each check on each change, so a reviewer who reruns a flaky failure (`--rerun` skips the cache)
replaces it in `lr status` and the handoff. Named changes get every check (or the ones `--check`
picks), whatever their `at`. It exits 1 if any check doesn't pass.

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
