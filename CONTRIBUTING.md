# Contributing

lr is a CLI (`lr`) and a web UI it serves (`lr ui`), in TypeScript on Bun. How it works is in
[the design](docs/design/). Read it before changing the model, and update it in the same change when
behavior diverges from it.

## Building from source

You need [Bun](https://bun.sh) 1.4.2 (pinned in `.tool-versions`) and
[jj](https://docs.jj-vcs.dev/) 0.45 or later.

```sh
bun install
bun run build       # standalone binary at dist/lr; copy it onto your PATH
```

To track your checkout instead of a build, put a shim named `lr` on your `PATH`:

```sh
#!/bin/sh
exec bun /path/to/local-review/src/bin.ts "$@"
```

The shim runs whichever `bun` resolves where you run `lr`, which with asdf may not be the pinned one
outside this repo. `lr ui` needs Bun 1.4.2 or later, and says so if it gets an older one.

To use the plugin from your checkout:

```sh
claude plugin marketplace add /path/to/local-review
claude plugin install local-review@local-review
claude --plugin-dir plugin       # or try it for one session, without installing it
```

## Commands

```sh
bun run check       # lint, typecheck, and tests with coverage; run it before calling work done
bun run fix         # Biome format plus safe lint fixes
bun test test/snapshot.test.ts   # a focused run; coverage thresholds only apply to bun run test
bun run lr <args>   # run the CLI from source
claude plugin validate . && claude plugin validate plugin   # after editing the plugin
```

Run `bun` from the repo root. Outside this directory the asdf shim may not resolve the pinned
version.

## Version control

This repo uses **jj** (colocated with git). Use `jj` for commits, splits, and history. Don't use
`git commit`/`git rebase`. Write commit subjects in the imperative ("Add …"), with a body when
the why isn't obvious.

## Dependencies

`bunfig.toml` pins exact versions and refuses packages published less than 3 days ago. Don't
bypass either (no `--minimum-release-age=0`, no `^` ranges). Avoid runtime dependencies:
`bun:sqlite`, `Bun.YAML`, `Bun.TOML`, `Bun.spawn`, and `node:util` `parseArgs` cover what we
need so far. The exceptions are React (`react`, `react-dom`) and markdown rendering
(`react-markdown`, `remark-gfm`, `remark-breaks`), which only the web UI uses and which are bundled
into the page.

## Code conventions

- **jj access goes through `src/jj.ts`.** Always read with explicit `-T` templates (JSON via
  `json(...)`), or `--git` for diffs. Never parse jj's default output, because user config can
  change it. Pin multi-read operations to one jj operation with `jj.at(opId)`.
- **Errors meant for the user throw `LrError`.** The CLI prints its message without a stack trace.
  Anything else is a bug and should crash loudly.
- **Process I/O is injected.** stdout, stderr and stdin come from the `Io` passed to `main()`
  (real ones in `src/bin.ts`). Read file-or-stdin arguments with `ctx.readInput()`, never
  `Bun.stdin` directly.
- **Every command supports `--json`.** Export the JSON output types from the command module (see
  `ReviewCreateOk`), since agents and the UI consume them.
- **Schema changes append to `MIGRATIONS` in `src/store.ts`.** Never edit a shipped migration.
- `noUncheckedIndexedAccess` is on and Biome's `noNonNullAssertion` is off. Use `!` where an
  index is known to exist; don't paper over it with `?.`.
- Biome formats: 2 spaces, 100 columns, double quotes.
- `scripts/` holds what CI and releases run. Its TypeScript is typechecked and tested like `src/`.

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
mention must exist, and their example plan and review must pass lr's validators.

## Tests

- Tests run against **real jj repos** (`TestRepo` in `test/helpers.ts`), with an isolated
  `JJ_CONFIG` and `$LOCAL_REVIEW_HOME` in a temp dir. Don't mock jj.
- Drive the CLI in-process with `lr()` / `lrJson<T>()` from `test/lr.ts`.
- Coverage must stay at ≥90% lines and functions **per file**. Bun has no branch coverage, so
  test error paths deliberately.

## CI

`.github/workflows/ci.yml` runs on pushes to main and on PRs, on Linux: `bun run check`, then a
build, then `scripts/smoke-test.sh`, which runs the compiled binary in a throwaway repo and checks
that `lr ui` serves the page and the API. The tests run on macOS locally and on Linux in CI, so keep
them free of either's paths and tools.

`.github/actions/setup` installs Bun from `.tool-versions` and jj from its release, pinned by
version and a checksum per platform. To move to a new jj, update the version and all four
checksums (the release's asset digests). Third-party actions are pinned by commit SHA.

## Releasing

1. Bump the version in `package.json` and `plugin/.claude-plugin/plugin.json` (a test keeps them
   equal), and push it to main on GitHub.
2. Run the **Release** workflow from the Actions tab, on main, or with
   `gh workflow run release.yml --ref main`.

It refuses a version that's already released. It runs the checks, builds lr for macOS and Linux on
arm64 and x64, publishes a GitHub release with the archives and `SHA256SUMS` (creating the
`v<version>` tag), writes the formula into
[`nick-telsan/homebrew-tap`](https://github.com/nick-telsan/homebrew-tap) with
`scripts/formula.ts`, and installs from the tap on macOS and Linux to confirm.

Updating the tap needs the `HOMEBREW_TAP_TOKEN` repository secret: a fine-grained token with
contents read/write on the tap only. When it expires, the tap step fails until the secret is
replaced; rerunning the failed jobs then finishes the release.
