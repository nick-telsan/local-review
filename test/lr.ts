import { main } from "../src/cli.ts";
import type { TestRepo } from "./helpers.ts";

export interface LrResult {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI in-process against a test repo. */
export async function lr(repo: TestRepo, ...args: string[]): Promise<LrResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "-R", repo.root], {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** `lr ... --json`, parsed as `T` (the command's JSON output type). */
export async function lrJson<T>(
  repo: TestRepo,
  ...args: string[]
): Promise<{ code: number; data: T; err: string }> {
  const r = await lr(repo, ...args, "--json");
  return { code: r.code, data: JSON.parse(r.out) as T, err: r.err };
}
