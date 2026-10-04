import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveName, formula, main, parseSums, TARGETS } from "../scripts/formula.ts";

const sha = (n: number) => String(n).repeat(64);
const SUMS = TARGETS.map((t, i) => `${sha(i + 1)}  ${archiveName("1.2.3", t)}`).join("\n");

describe("the Homebrew formula", () => {
  test("has a URL and checksum for each platform, and depends on jj", () => {
    const rb = formula({ repo: "me/lr", version: "1.2.3", sums: parseSums(SUMS) });
    expect(rb).toContain('version "1.2.3"');
    expect(rb).toContain('depends_on "jj"');
    expect(rb).toContain('homepage "https://github.com/me/lr"');
    // Each platform's block names its own archive, with that archive's checksum.
    const blocks = [...rb.matchAll(/on_(arm|intel) do\n\s+url "([^"]+)"\n\s+sha256 "(\w+)"/g)];
    expect(blocks.map((m) => [m[1], m[2]!.split("/").at(-1), m[3]])).toEqual([
      ["arm", "lr-1.2.3-darwin-arm64.tar.gz", sha(1)],
      ["intel", "lr-1.2.3-darwin-x64.tar.gz", sha(2)],
      ["arm", "lr-1.2.3-linux-arm64.tar.gz", sha(3)],
      ["intel", "lr-1.2.3-linux-x64.tar.gz", sha(4)],
    ]);
    expect(blocks[0]![2]).toBe(
      "https://github.com/me/lr/releases/download/v1.2.3/lr-1.2.3-darwin-arm64.tar.gz",
    );
  });

  test("refuses a release it can't describe", () => {
    const sums = parseSums(SUMS);
    expect(() => formula({ repo: "lr", version: "1.2.3", sums })).toThrow("--repo must be");
    expect(() => formula({ repo: "me/lr", version: "v1.2.3", sums })).toThrow("--version must be");
    sums.delete("lr-1.2.3-linux-x64.tar.gz");
    expect(() => formula({ repo: "me/lr", version: "1.2.3", sums })).toThrow(
      "no checksum for lr-1.2.3-linux-x64.tar.gz",
    );
  });

  test("reads sha256sum output, text or binary mode", () => {
    const sums = parseSums(`${sha(1)}  a.tar.gz\n${sha(2)} *b.tar.gz\n\n`);
    expect([...sums]).toEqual([
      ["a.tar.gz", sha(1)],
      ["b.tar.gz", sha(2)],
    ]);
    expect(() => parseSums("nope  a.tar.gz")).toThrow("not a sha256sum line: nope  a.tar.gz");
  });
});

describe("formula.ts", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lr-formula-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("reads the sums file it's given", async () => {
    const path = join(tmp, "SHA256SUMS");
    await Bun.write(path, SUMS);
    const rb = await main(["--repo", "me/lr", "--version", "1.2.3", "--sums", path]);
    expect(rb).toBe(formula({ repo: "me/lr", version: "1.2.3", sums: parseSums(SUMS) }));
    await expect(main(["--repo", "me/lr"])).rejects.toThrow("usage: formula.ts");
  });
});
