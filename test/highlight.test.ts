import { expect, spyOn, test } from "bun:test";
import type { DiffLine, FileDiff } from "../src/patch.ts";
import {
  diffLanguage,
  fenceLanguage,
  highlight,
  highlightHunk,
  joinLines,
  LANGS,
  type Lang,
  languageOf,
  MAX_DIFF_LINES,
  MAX_LINE,
  type Token,
} from "../src/web/highlight.ts";

/** The light theme's color for the token holding `text`. */
const color = (line: Token[], text: string) =>
  line.find((t) => t.text.includes(text))?.style["--shiki-light"];

test("files get a grammar by extension or name, and anything else stays plain", () => {
  expect(languageOf("src/web/Diff.tsx")).toBe("tsx");
  expect(languageOf("a/b.TS")).toBe("typescript");
  expect(languageOf("lib/x.mjs")).toBe("javascript");
  expect(languageOf("app/models/user.rb")).toBe("ruby");
  expect(languageOf("app/views/x.html.erb")).toBe("erb");
  expect(languageOf("index.php")).toBe("php");
  expect(languageOf("tsconfig.jsonc")).toBe("json");
  expect(languageOf("Makefile")).toBe("make");
  expect(languageOf("docker/Dockerfile.dev")).toBe("docker");
  expect(languageOf("Gemfile")).toBe("ruby");

  expect(languageOf("notes.xyz")).toBeNull();
  expect(languageOf("LICENSE")).toBeNull();
  expect(languageOf(".gitignore")).toBeNull();
  expect(languageOf("constructor")).toBeNull();
  expect(languageOf("x.constructor")).toBeNull();
});

test("code fences get a grammar by extension, by the grammar's name, or by an alias", () => {
  expect(fenceLanguage("ts")).toBe("typescript");
  expect(fenceLanguage("TypeScript")).toBe("typescript");
  expect(fenceLanguage("sh")).toBe("shellscript");
  expect(fenceLanguage("shell")).toBe("shellscript");
  expect(fenceLanguage(" ruby title=x.rb")).toBe("ruby");
  expect(fenceLanguage("golang")).toBe("go");

  expect(fenceLanguage("mermaid")).toBeNull();
  expect(fenceLanguage("toString")).toBeNull();
});

test("every grammar loads and highlights", async () => {
  for (const lang of LANGS) {
    const lines = (await highlight("x = 1", lang))!;
    expect(lines.map((l) => l.map((t) => t.text).join(""))).toEqual(["x = 1"]);
  }
});

test("tokens carry the light and dark themes' colors, and default-colored text has none", async () => {
  const [line] = (await highlight("const x = 1;", "typescript"))!;
  const keyword = line!.find((t) => t.text === "const")!;
  expect(keyword.style["--shiki-light"]).toMatch(/^#[0-9A-F]{6}$/i);
  expect(keyword.style["--shiki-dark"]).toMatch(/^#[0-9A-F]{6}$/i);
  expect(keyword.style["--shiki-light"]).not.toBe(keyword.style["--shiki-dark"]);
  expect(line!.find((t) => t.text === " ")!.style).toEqual({});

  const [, , markdown] = (await highlight("*a*\n\n**b**", "markdown"))!;
  expect(markdown![0]!.style["--shiki-light-font-weight"]).toBe("bold");
});

test("results are cached by language and text, as the same promise", async () => {
  const a = highlight("let y = 2;", "typescript");
  expect(highlight("let y = 2;", "typescript")).toBe(a);
  expect(highlight("let y = 2;", "javascript")).not.toBe(a);
  // Those two and 498 more fill the cache, and using one keeps it.
  const more = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => highlight(`${from + i}`, "json"));
  const filled = more(0, 498);
  expect(highlight("let y = 2;", "typescript")).toBe(a);
  // Past its size, the least recently used goes.
  const past = more(498, 499);
  expect(highlight("let y = 2;", "typescript")).toBe(a);
  expect(highlight("0", "json")).not.toBe(filled[0]);
  await Promise.all([a, ...filled, ...past]);
});

test("text that can't be highlighted is null, to show plain, and says why", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await highlight("x", "cobol" as Lang)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toBe("Couldn't highlight cobol:");
    expect(await highlightHunk([line("add", "x")], "cobol" as Lang)).toBeNull();
  } finally {
    error.mockRestore();
  }
});

test("a line longer than the limit stays plain", async () => {
  const long = `const s = "${"x".repeat(MAX_LINE)}";`;
  const [line, next] = (await highlight(`${long}\nconst t = 1;`, "typescript"))!;
  expect(line!.map((t) => t.text).join("")).toBe(long);
  expect(line!.every((t) => !t.style["--shiki-light"])).toBe(true);
  expect(color(next!, "const")).toBeDefined();
});

const line = (kind: DiffLine["kind"], text: string): DiffLine => ({
  kind,
  oldLine: kind === "add" ? null : 1,
  newLine: kind === "del" ? null : 1,
  text,
  noNewline: false,
});

test("a hunk's sides are highlighted as wholes, so a block comment spans its lines", async () => {
  const hunk = [
    line("context", "const a = 1;"),
    line("add", "/* one"),
    line("add", "   two */"),
    line("del", "const b = `x"),
    line("del", "y`;"),
    line("context", "const c = 3;"),
  ];
  const tokens = (await highlightHunk(hunk, "typescript"))!;
  expect(tokens.map((l) => l.map((t) => t.text).join(""))).toEqual(hunk.map((l) => l.text));

  const comment = color(tokens[1]!, "one");
  expect(comment).toBeDefined();
  expect(color(tokens[2]!, "two")).toBe(comment);
  // The added comment doesn't swallow the removed lines: they're on the old side.
  const string = color(tokens[3]!, "`x");
  expect(string).toBeDefined();
  expect(string).not.toBe(comment);
  expect(color(tokens[4]!, "y`")).toBe(string);
  expect(color(tokens[5]!, "const")).toBe(color(tokens[0]!, "const"));
});

test("a diff gets its file's grammar, unless it's binary or too long", () => {
  const file = (path: string, lines: number, binary = false): FileDiff => ({
    status: "added",
    oldPath: null,
    newPath: path,
    binary,
    mode: null,
    hunks: [
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: lines, lines: [] },
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: lines, lines: [] },
    ].map((h, i) => ({
      ...h,
      lines: Array.from({ length: i === 0 ? Math.ceil(lines / 2) : Math.floor(lines / 2) }, () =>
        line("add", "x"),
      ),
    })),
    added: lines,
    removed: 0,
  });
  expect(diffLanguage(file("a.ts", 3))).toBe("typescript");
  expect(diffLanguage(file("a.ts", MAX_DIFF_LINES))).toBe("typescript");
  // Counted across the file's hunks.
  expect(diffLanguage(file("a.ts", MAX_DIFF_LINES + 1))).toBeNull();
  expect(diffLanguage(file("a.png", 0, true))).toBeNull();
  expect(diffLanguage(file("notes.xyz", 3))).toBeNull();
  expect(
    diffLanguage({ ...file("old.rb", 3), status: "deleted", oldPath: "old.rb", newPath: null }),
  ).toBe("ruby");
});

test("a CRLF line keeps its \\r, as a token of its own, on either side", async () => {
  const hunk = [
    line("context", "/* a\r"),
    line("del", "   b */\r"),
    line("add", "   c */\r"),
    line("add", "const d = 1;"),
    line("context", "\r"),
  ];
  const tokens = (await highlightHunk(hunk, "typescript"))!;
  expect(tokens.map((l) => l.map((t) => t.text).join(""))).toEqual(hunk.map((l) => l.text));
  for (const l of tokens) expect(new Set(l.map((t) => t.offset)).size).toBe(l.length);
  // Offsets count from the start of the side's text: "/* a\n" then "   b */".
  expect(tokens[1]!.at(-1)).toEqual({ text: "\r", offset: 12, style: {} });
  expect(tokens[4]).toEqual([{ text: "\r", offset: 0, style: {} }]);
  // The comment still spans its lines.
  expect(color(tokens[1]!, "b */")).toBe(color(tokens[0]!, "/* a"));
  expect(color(tokens[2]!, "c */")).toBe(color(tokens[0]!, "/* a"));
});

test("lines join into one run, with a newline token between each", async () => {
  const lines = (await highlight("const a = 1;\n\n// two\n", "typescript"))!;
  const run = joinLines(lines);
  expect(run.map((t) => t.text).join("")).toBe("const a = 1;\n\n// two\n");
  expect(new Set(run.map((t) => t.offset)).size).toBe(run.length);
  expect(run.filter((t) => t.text === "\n").map((t) => t.offset)).toEqual([12, 13, 20]);
  expect(joinLines([])).toEqual([]);
});
