# local-review

A local code review tool for agentic development: a CLI (`lr`), and a web UI it serves (`lr ui`). The
design lives in `docs/design/data-model.md`. Read it before changing the model, and update it in
the same change when behavior diverges from it.

## Commands

- `bun run check`: lint, typecheck, and tests with coverage. Run it before calling work done.
- `bun run fix`: Biome format plus safe lint fixes.
- `bun test test/<file>.test.ts`: a focused run. Coverage thresholds only apply to `bun run test`.
- `bun run lr <args>`: run the CLI from source.

Run `bun` from the repo root. The version is pinned in `.tool-versions` (asdf), and outside this
directory the shim may not resolve.

## Version control

This repo uses **jj** (colocated with git). Use `jj` for commits, splits, and history. Don't use
`git commit`/`git rebase`. Write commit subjects in the imperative ("Add …"), with a body when
the why isn't obvious.

## Dependencies

`bunfig.toml` pins exact versions and refuses packages published less than 3 days ago. Don't
bypass either (no `--minimum-release-age=0`, no `^` ranges). Avoid runtime dependencies:
`bun:sqlite`, `Bun.YAML`, `Bun.TOML`, `Bun.spawn`, and `node:util` `parseArgs` cover what we
need so far. The exceptions are React (`react`, `react-dom`) and markdown rendering
(`react-markdown`, `remark-gfm`, `remark-breaks`), which only the web UI uses and which are bundled into the page.

## Code conventions

- **jj access goes through `src/jj.ts`.** Always read with explicit `-T` templates (JSON via
  `json(...)`), or `--git` for diffs. Never parse jj's default output, because user config can
  change it. Pin multi-read
  operations to one jj operation with `jj.at(opId)`.
- **Errors meant for the user throw `LrError`.** The CLI prints its message without a stack trace.
  Anything else is a bug and should crash loudly.
- **Process I/O is injected.** stdout, stderr and stdin come from the `Io` passed to `main()`
  (real ones in `src/bin.ts`). Read file-or-stdin arguments with `ctx.readInput()`, never
  `Bun.stdin` directly.
- **Every command supports `--json`.** Export the JSON output types from the command module (see
  `ReviewCreateOk`), since agents and the future UI consume them.
- **Schema changes append to `MIGRATIONS` in `src/store.ts`.** Never edit a shipped migration.
- `noUncheckedIndexedAccess` is on and Biome's `noNonNullAssertion` is off. Use `!` where an
  index is known to exist; don't paper over it with `?.`.
- Biome formats: 2 spaces, 100 columns, double quotes.

## Web UI

`src/web/` is the React app `lr ui` serves; `src/ui/` is its server and API. The API's types live
in `src/ui/api.ts`, and `src/web/` imports them type-only. The only runtime code it shares is
`src/patch.ts`, which must stay free of Bun APIs, since it runs in the browser too. Tests cover the
server and API against real repos; the React code has no tests yet, so check UI changes in a
browser. With `LR_UI_DEV=1`, `lr ui` serves the page with hot reloading.

## Claude Code plugin

`plugin/` holds the skills and hooks, and `.claude-plugin/marketplace.json` lists it. Hooks are
thin shell commands that call `lr hook <event>`, so their logic stays in `src/commands/hook.ts`,
where it's tested. `test/plugin.test.ts` checks the skills against the CLI: every `lr` command they
mention must exist, and their example plan and review must pass lr's validators. After editing the
plugin, run `claude plugin validate . && claude plugin validate plugin`.

## Tests

- Tests run against **real jj repos** (`TestRepo` in `test/helpers.ts`), with an isolated
  `JJ_CONFIG` and `$LOCAL_REVIEW_HOME` in a temp dir. Don't mock jj.
- Drive the CLI in-process with `lr()` / `lrJson<T>()` from `test/lr.ts`.
- Coverage must stay at ≥90% lines and functions **per file**. Bun has no branch coverage, so
  test error paths deliberately.
