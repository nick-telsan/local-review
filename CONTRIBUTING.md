# Contributing

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

## Development

```sh
bun run check       # lint + typecheck + tests with coverage (≥90% lines and functions, per file)
bun run fix         # format and apply safe lint fixes
bun test test/snapshot.test.ts   # one file, no coverage thresholds
claude plugin validate . && claude plugin validate plugin
```
