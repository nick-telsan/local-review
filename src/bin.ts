#!/usr/bin/env bun
import { main } from "./cli.ts";

const code = await main(Bun.argv.slice(2), {
  out: (t) => console.log(t),
  err: (t) => console.error(t),
  stdin: () => Bun.stdin.text(),
});
process.exit(code);
