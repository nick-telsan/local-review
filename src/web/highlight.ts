// Syntax highlighting for the diff and markdown code blocks, with Shiki: TextMate grammars, as VS
// Code and GitHub use, run by its JavaScript regex engine (no WASM). Only the grammars listed here
// are bundled into the page, and each is compiled the first time it's used.
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { type DiffLine, type FileDiff, filePath } from "../patch.ts";

const GRAMMARS = {
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  erb: () => import("shiki/langs/erb.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

export type Lang = keyof typeof GRAMMARS;

export const LANGS = Object.keys(GRAMMARS) as Lang[];

/** By file extension, and by code fence (` ```ts `), lowercased. */
const EXTENSIONS: Record<string, Lang> = {
  bash: "shellscript",
  cjs: "javascript",
  css: "css",
  cts: "typescript",
  diff: "diff",
  dockerfile: "docker",
  erb: "erb",
  gemspec: "ruby",
  go: "go",
  htm: "html",
  html: "html",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  patch: "diff",
  php: "php",
  py: "python",
  rake: "ruby",
  rb: "ruby",
  rs: "rust",
  sh: "shellscript",
  sql: "sql",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript",
};

/** Files known by name. */
const NAMES: Record<string, Lang> = {
  Dockerfile: "docker",
  GNUmakefile: "make",
  Gemfile: "ruby",
  Makefile: "make",
  Rakefile: "ruby",
  makefile: "make",
};

/** Code fences' names that aren't an extension or a grammar's own name. */
const FENCES: Record<string, Lang> = {
  console: "shellscript",
  golang: "go",
  shell: "shellscript",
};

/** The grammar for a file, by its name, or null to leave it plain. */
export function languageOf(path: string): Lang | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (Object.hasOwn(NAMES, name)) return NAMES[name]!;
  if (name.startsWith("Dockerfile.")) return "docker";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? lookup(EXTENSIONS, name.slice(dot + 1).toLowerCase()) : null;
}

/** Diffs longer than this stay plain: highlighting them would hold up the page. */
export const MAX_DIFF_LINES = 5_000;

/** The grammar for a file's diff, or null to leave it plain: a binary, an unknown type, or too long. */
export function diffLanguage(file: FileDiff): Lang | null {
  const lines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  return file.binary || lines > MAX_DIFF_LINES ? null : languageOf(filePath(file));
}

/** The grammar for a code fence's info string (` ```ts title="x" `), or null. */
export function fenceLanguage(info: string): Lang | null {
  const name = info.trim().split(/\s/)[0]!.toLowerCase();
  return lookup(EXTENSIONS, name) ?? lookup(FENCES, name) ?? (isLang(name) ? name : null);
}

const lookup = (map: Record<string, Lang>, key: string): Lang | null =>
  Object.hasOwn(map, key) ? map[key]! : null;

const isLang = (name: string): name is Lang => Object.hasOwn(GRAMMARS, name);

/**
 * A run of text in one style: CSS variables with the light and dark themes' color, and italics or
 * bold where they have them (`--shiki-light`, `--shiki-dark-font-style`, …). Text in the themes'
 * default color has none, and takes the page's.
 */
export interface Token {
  text: string;
  /** Where it starts in the text highlighted: unique on its line. */
  offset: number;
  style: Record<string, string>;
}

const LIGHT = "github-light-default";
const DARK = "github-dark-default";

/** Longer lines stay plain: tokenizing one can take a long time. */
export const MAX_LINE = 1_000;

/** The highlighter, and the themes' default text colors. */
interface Shiki {
  h: HighlighterCore;
  fg: [string, string];
}

let shiki: Promise<Shiki> | null = null;
const loaded = new Map<Lang, Promise<void>>();

async function highlighter(lang: Lang): Promise<Shiki> {
  shiki ??= createHighlighterCore({
    themes: [
      import("shiki/themes/github-light-default.mjs"),
      import("shiki/themes/github-dark-default.mjs"),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  }).then((h) => ({
    h,
    // Tokens' colors are uppercase; the themes' are lowercase.
    fg: [h.getTheme(LIGHT).fg.toUpperCase(), h.getTheme(DARK).fg.toUpperCase()],
  }));
  const s = await shiki;
  let grammar = loaded.get(lang);
  if (!grammar) {
    grammar = s.h.loadLanguage(GRAMMARS[lang]());
    loaded.set(lang, grammar);
  }
  await grammar;
  return s;
}

/** Recent results, by language and text: the page refetches what it shows after every write. */
const cache = new Map<string, Promise<Token[][] | null>>();
const CACHE_SIZE = 500;

/**
 * `text`'s tokens, line by line, or null if it couldn't be highlighted (and should show plain).
 * The same text gets the same promise back while it's cached, so React's `use` can wait on it.
 */
export function highlight(text: string, lang: Lang): Promise<Token[][] | null> {
  const key = `${lang}\n${text}`;
  let lines = cache.get(key);
  // Most recently used goes last; the first is the next to go.
  cache.delete(key);
  lines ??= tokenize(text, lang).catch((e) => {
    console.error(`Couldn't highlight ${lang}:`, e);
    return null;
  });
  cache.set(key, lines);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return lines;
}

async function tokenize(text: string, lang: Lang): Promise<Token[][]> {
  const { h, fg } = await highlighter(lang);
  const { tokens } = h.codeToTokens(text, {
    lang,
    themes: { light: LIGHT, dark: DARK },
    defaultColor: false,
    tokenizeMaxLineLength: MAX_LINE,
  });
  return tokens.map((line) =>
    line.map((t): Token => {
      const style = { ...t.htmlStyle };
      if (style["--shiki-light"] === fg[0] && style["--shiki-dark"] === fg[1]) {
        delete style["--shiki-light"];
        delete style["--shiki-dark"];
      }
      return { text: t.content, offset: t.offset, style };
    }),
  );
}

/**
 * Each of a hunk's lines' tokens, or null to show it plain. The old side (context and removed
 * lines) and the new side (context and added lines) are each highlighted as one text, so a block
 * comment or a string that spans lines colors as it does in the file. A removed line takes the old
 * side's tokens; an added or context line, the new side's.
 *
 * A CRLF file's lines end in `\r`, which Shiki would take as part of the line break, dropping it
 * from every line but a side's last. Each line is highlighted without it, and gets it back as a
 * token of its own, so its text is unchanged.
 */
export async function highlightHunk(lines: DiffLine[], lang: Lang): Promise<Token[][] | null> {
  const bare = (l: DiffLine) => (l.text.endsWith("\r") ? l.text.slice(0, -1) : l.text);
  const text = (side: DiffLine[]) => side.map(bare).join("\n");
  const [old, neu] = await Promise.all([
    highlight(text(lines.filter((l) => l.kind !== "add")), lang),
    highlight(text(lines.filter((l) => l.kind !== "del")), lang),
  ]);
  if (!old || !neu) return null;
  let o = 0;
  let n = 0;
  return lines.map((l) => {
    if (l.kind === "context") o++;
    const tokens = l.kind === "del" ? old[o++]! : neu[n++]!;
    if (!l.text.endsWith("\r")) return tokens;
    const last = tokens.at(-1);
    return [
      ...tokens,
      { text: "\r", offset: last ? last.offset + last.text.length : 0, style: {} },
    ];
  });
}
