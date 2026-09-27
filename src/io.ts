import { LrError } from "./errors.ts";

/** Read a file argument; `-` means stdin. */
export async function readInput(path: string, stdin: () => Promise<string>): Promise<string> {
  if (path === "-") return stdin();
  const f = Bun.file(path);
  if (!(await f.exists())) throw new LrError(`no such file: ${path}`);
  return f.text();
}
