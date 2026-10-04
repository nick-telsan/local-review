/**
 * Split a shell command the way Bash reads it, far enough to tell which programs it runs with
 * which arguments. It's not a shell: variables, globs, aliases and brace expansion stay as written,
 * and an unterminated quote runs to the end of the text.
 */

/** A simple command: its words with quoting removed, and what it reads on stdin from the text. */
export interface SimpleCommand {
  words: string[];
  /** Heredoc bodies and here-strings. They aren't words of the command. */
  stdin: string[];
}

export interface Script {
  commands: SimpleCommand[];
  /**
   * The text of each command substitution (`$(…)`, backticks, `<(…)`, `>(…)`, and those in an
   * unquoted heredoc), which runs as a script itself.
   */
  substitutions: string[];
  /**
   * Whether the text ends inside a quote, a substitution, or a heredoc. What's left runs to the
   * end, so the split may not be what the shell would run.
   */
  unterminated: boolean;
}

export function splitCommand(text: string): Script {
  return new Splitter(text).run();
}

const BLANKS = " \t";
const SEPARATORS = ";&|()\n";

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
  /** Whether the shell expands `$(…)` and backticks in the body: the delimiter isn't quoted. */
  expands: boolean;
  command: SimpleCommand;
}

class Splitter {
  private i: number;
  private readonly commands: SimpleCommand[] = [];
  private readonly substitutions: string[] = [];
  private unterminated = false;
  private command: SimpleCommand = { words: [], stdin: [] };
  private word: string | null = null;
  /** Where the next word goes, when it isn't one of the command's: a redirection's target. */
  private target: "drop" | "stdin" | null = null;
  /** Heredocs whose bodies start on the next line. */
  private pending: Heredoc[] = [];
  /** Open parentheses, and for a substitution, whether its closing one has been read. */
  private depth = 0;
  private closed = false;

  /** `nested`: read a `$(…)` from `start`, stopping after the `)` that closes it. */
  constructor(
    private readonly s: string,
    start = 0,
    private readonly nested = false,
  ) {
    this.i = start;
  }

  run(): Script {
    while (this.i < this.s.length && !this.closed) this.step();
    this.endCommand();
    if (!this.closed) this.readHeredocs();
    if (this.nested && !this.closed) this.unterminated = true;
    return {
      commands: this.commands,
      substitutions: this.substitutions,
      unterminated: this.unterminated,
    };
  }

  private step(): void {
    const s = this.s;
    const c = s[this.i]!;
    if (c === "\\" && s[this.i + 1] === "\n") {
      this.i += 2; // a line continuation
    } else if (BLANKS.includes(c)) {
      this.endWord();
      this.i++;
    } else if (c === "\n") {
      this.endCommand();
      this.i++;
      this.readHeredocs();
    } else if (c === "#" && this.word === null) {
      const nl = s.indexOf("\n", this.i);
      this.i = nl === -1 ? s.length : nl;
    } else if (SEPARATORS.includes(c)) {
      this.endCommand();
      this.i++;
      if (c === "(") this.depth++;
      else if (c === ")" && this.depth > 0) this.depth--;
      else if (c === ")" && this.nested) this.closed = true;
    } else if ((c === "<" || c === ">") && s[this.i + 1] !== "(") {
      this.readRedirection();
    } else {
      this.readWordPart();
    }
  }

  private endWord(): void {
    if (this.word === null) return;
    if (this.target === "stdin") this.command.stdin.push(this.word);
    else if (this.target === null) this.command.words.push(this.word);
    this.target = null;
    this.word = null;
  }

  private endCommand(): void {
    this.endWord();
    this.target = null;
    if (this.command.words.length > 0) this.commands.push(this.command);
    this.command = { words: [], stdin: [] };
  }

  private readRedirection(): void {
    const s = this.s;
    // A file descriptor right before the operator (`2>&1`) belongs to the redirection.
    if (this.word !== null && /^\d+$/.test(this.word)) this.word = null;
    this.endWord();
    if (s.startsWith("<<<", this.i)) {
      this.i += 3;
      this.target = "stdin";
    } else if (s.startsWith("<<", this.i)) {
      this.i += 2;
      const stripTabs = s[this.i] === "-";
      if (stripTabs) this.i++;
      while (BLANKS.includes(s[this.i] ?? "")) this.i++;
      const from = this.i;
      this.word = "";
      while (this.i < s.length && !`${BLANKS}${SEPARATORS}<>`.includes(s[this.i]!)) {
        this.readWordPart();
      }
      const expands = !/['"\\]/.test(s.slice(from, this.i));
      this.pending.push({ delimiter: this.word, stripTabs, expands, command: this.command });
      this.word = null;
    } else {
      do this.i++;
      while ("<>&|".includes(s[this.i] ?? "\0"));
      this.target = "drop";
    }
  }

  /** After a newline: the bodies of the heredocs opened on the line before. */
  private readHeredocs(): void {
    const s = this.s;
    for (const doc of this.pending) {
      const lines: string[] = [];
      let ended = false;
      while (this.i < s.length && !ended) {
        const nl = s.indexOf("\n", this.i);
        const end = nl === -1 ? s.length : nl;
        const line = s.slice(this.i, end);
        this.i = end + 1;
        ended = (doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter;
        if (!ended) lines.push(line);
      }
      if (!ended) this.unterminated = true;
      const body = lines.join("\n");
      doc.command.stdin.push(body);
      if (doc.expands) this.readExpansions(body);
    }
    this.pending = [];
  }

  /** Record the substitutions in an unquoted heredoc's body, which the shell runs. */
  private readExpansions(body: string): void {
    const inner = new Splitter(body);
    let j = 0;
    while (j < body.length) {
      const c = body[j]!;
      if (c === "\\") j += 2;
      else if (c === "$" && body[j + 1] === "(") j = inner.readSubstitution(j + 2);
      else if (c === "`") j = inner.readBackticks(j);
      else j++;
    }
    this.substitutions.push(...inner.substitutions);
    if (inner.unterminated) this.unterminated = true;
  }

  /** One piece of a word: a character, an escape, a quoted string, or a substitution. */
  private readWordPart(): void {
    const s = this.s;
    const c = s[this.i]!;
    this.word ??= "";
    if (c === "'") {
      let end = s.indexOf("'", this.i + 1);
      if (end === -1) {
        end = s.length;
        this.unterminated = true;
      }
      this.word += s.slice(this.i + 1, end);
      this.i = end + 1;
    } else if (c === "$" && s[this.i + 1] === "'") {
      this.readAnsiC();
    } else if (c === '"') {
      this.readDoubleQuoted();
    } else if ("$<>".includes(c) && s[this.i + 1] === "(") {
      // `$(…)`, or a process substitution: `<(…)` or `>(…)`.
      const end = this.readSubstitution(this.i + 2);
      this.word += s.slice(this.i, end);
      this.i = end;
    } else if (c === "`") {
      const end = this.readBackticks(this.i);
      this.word += s.slice(this.i, end);
      this.i = end;
    } else if (c === "\\") {
      this.word += s[this.i + 1] ?? "";
      this.i += 2;
    } else {
      this.word += c;
      this.i++;
    }
  }

  /** `$'…'`, with its common backslash escapes. */
  private readAnsiC(): void {
    const s = this.s;
    const escapes: Record<string, string> = { n: "\n", t: "\t" };
    let j = this.i + 2;
    while (j < s.length && s[j] !== "'") {
      if (s[j] === "\\" && j + 1 < s.length) {
        const e = s[j + 1]!;
        this.word += escapes[e] ?? e;
        j += 2;
      } else {
        this.word += s[j]!;
        j++;
      }
    }
    if (j >= s.length) this.unterminated = true;
    this.i = j + 1;
  }

  private readDoubleQuoted(): void {
    const s = this.s;
    let j = this.i + 1;
    while (j < s.length && s[j] !== '"') {
      const c = s[j]!;
      if (c === "\\" && j + 1 < s.length) {
        const e = s[j + 1]!;
        // Inside double quotes a backslash only escapes these; elsewhere it stays.
        if (e !== "\n") this.word += '"\\$`'.includes(e) ? e : c + e;
        j += 2;
      } else if (c === "$" && s[j + 1] === "(") {
        const end = this.readSubstitution(j + 2);
        this.word += s.slice(j, end);
        j = end;
      } else if (c === "`") {
        const end = this.readBackticks(j);
        this.word += s.slice(j, end);
        j = end;
      } else {
        this.word += c;
        j++;
      }
    }
    if (j >= s.length) this.unterminated = true;
    this.i = j + 1;
  }

  /**
   * Record a substitution whose text starts at `start`, reading it as a script up to the `)` that
   * closes it, so quotes, heredocs and comments inside it can't end it early or hide its end.
   * Returns the index after its `)`.
   */
  private readSubstitution(start: number): number {
    const inner = new Splitter(this.s, start, true);
    const { unterminated } = inner.run();
    const end = inner.closed ? inner.i : this.s.length;
    this.substitutions.push(this.s.slice(start, inner.closed ? end - 1 : end));
    if (unterminated) this.unterminated = true;
    return end;
  }

  /** Record a backtick substitution starting at `at`; returns the index after its closing one. */
  private readBackticks(at: number): number {
    const s = this.s;
    let j = at + 1;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) this.unterminated = true;
    this.substitutions.push(s.slice(at + 1, j).replace(/\\([`\\$])/g, "$1"));
    return Math.min(j + 1, s.length);
  }
}
