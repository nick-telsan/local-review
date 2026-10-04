# Claude Code integration

`plugin/` is a Claude Code plugin, listed by the marketplace at the repo root. It has two skills,
`lr-author` and `lr-review`, and three hooks. The skills and hooks also work installed on their own
(skills in `~/.claude/skills/`, hooks in `settings.json`), so each hook is a plain shell command
that calls `lr hook <event>` and does nothing if `lr` isn't on `PATH`. The logic lives in lr, where
it's tested.

- **SessionStart:** if the repo has lr state and one active feature, it prints the feature's status
  and next step, which becomes session context. It also records the stack as the session found it.
  Resume and compaction keep the same record.
- **PreToolUse (Bash):** if a command runs lr as a human (`--as human:…`, `--as <name>`,
  `LR_ACTOR=<human>`, or `lr ui`, which acts as the OS user), it returns `ask` so the developer
  confirms. It reads the command as the shell would (`src/shell.ts`): `--as` and `ui` count only as
  lr's own arguments, and `LR_ACTOR` only where it's set (before the program, or after `env` or
  `export`), so the same text in a quoted reply, a heredoc or a grep pattern doesn't. It follows the
  scripts a command runs: substitutions (including process substitutions, and those in an unquoted
  heredoc), `sh -c`, `eval`, and a heredoc fed to a shell. When it can't read the command for
  certain (a shell reads a script from a pipe, or the text ends inside a quote, substitution or
  heredoc), it falls back to matching the whole text, erring toward asking.
- **Stop:** if the feature is `implementing` or `revising`, and the stack differs from both how the
  session found it and the latest round, it blocks the stop once (exit 2) with a reminder: open a
  round with `lr review create`, or say what's left. It fires once per stack state, and never while
  `stop_hook_active`. The plugin's `stop_reminder` option turns it off.

Session records live in `<repo-key>/sessions/<session id>.json`.
