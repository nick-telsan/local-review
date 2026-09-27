# local-review

A local code review tool for agentic development: a CLI (`lr`) now, a desktop UI later. The
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
need so far.

## Code conventions

- **jj access goes through `src/jj.ts`.** Always read with explicit `-T` templates (JSON via
  `json(...)`). Never parse jj's default output, because user config can change it. Pin multi-read
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

## Tests

- Tests run against **real jj repos** (`TestRepo` in `test/helpers.ts`), with an isolated
  `JJ_CONFIG` and `$LOCAL_REVIEW_HOME` in a temp dir. Don't mock jj.
- Drive the CLI in-process with `lr()` / `lrJson<T>()` from `test/lr.ts`.
- Coverage must stay at ≥90% lines and functions **per file**. Bun has no branch coverage, so
  test error paths deliberately.
