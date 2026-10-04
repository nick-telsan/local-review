import { expect, test } from "bun:test";
import { splitCommand } from "../src/shell.ts";

const words = (text: string) => splitCommand(text).commands.map((c) => c.words);

test("words, with quotes and escapes removed", () => {
  expect(words(`lr reply 7 --addressed "it's in 'kxqp'" 'a "b"' c\\ d`)).toEqual([
    ["lr", "reply", "7", "--addressed", "it's in 'kxqp'", 'a "b"', "c d"],
  ]);
  // Parts of one word join; in double quotes a backslash only escapes ", \, $ and `.
  expect(words(`a"b"'c'd "\\"\\n\\$" $'x\\ty\\'z'`)).toEqual([["abcd", '"\\n$', "x\ty'z"]]);
  expect(words("lr \\\n  ui\n")).toEqual([["lr", "ui"]]);
  expect(words(`"one \\\ntwo"`)).toEqual([["one two"]]);
});

test("separators split commands", () => {
  expect(words("cd x && lr ui; a | b || c & d\n(e) {")).toEqual([
    ["cd", "x"],
    ["lr", "ui"],
    ["a"],
    ["b"],
    ["c"],
    ["d"],
    ["e"],
    ["{"],
  ]);
  expect(words("")).toEqual([]);
});

test("comments run to the end of the line, but only at the start of a word", () => {
  expect(words("lr status # lr ui\nlr a#b")).toEqual([
    ["lr", "status"],
    ["lr", "a#b"],
  ]);
  expect(words("# only a comment")).toEqual([]);
});

test("redirections' targets aren't words", () => {
  expect(words("lr status > out.txt 2>&1 <in >>log x")).toEqual([["lr", "status", "x"]]);
  expect(words("a 2>/dev/null")).toEqual([["a"]]);
  // A target left without a word doesn't carry past the end of the command.
  expect(words("a >; lr ui")).toEqual([["a"], ["lr", "ui"]]);
});

test("heredocs and here-strings are the command's stdin", () => {
  const script = splitCommand(
    "lr reply 3 -F - <<'EOF'\nsee lr ui\n  EOF\nEOF\ncat <<-END | sh\n\tlr ui\n\tEND\nbash <<< 'lr ui'",
  );
  expect(script.commands).toEqual([
    { words: ["lr", "reply", "3", "-F", "-"], stdin: ["see lr ui\n  EOF"] },
    { words: ["cat"], stdin: ["\tlr ui"] },
    { words: ["sh"], stdin: [] },
    { words: ["bash"], stdin: ["lr ui"] },
  ]);
  expect(script.unterminated).toBe(false);
  // A heredoc with no body, or one that never ends.
  expect(splitCommand("cat <<EOF")).toMatchObject({
    commands: [{ words: ["cat"], stdin: [""] }],
    unterminated: true,
  });
  expect(splitCommand("cat <<EOF\na\nb")).toMatchObject({
    commands: [{ words: ["cat"], stdin: ["a\nb"] }],
    unterminated: true,
  });
});

test("an unquoted heredoc's substitutions run; a quoted one's don't", () => {
  const body = "see $(lr ui) and `lr status` but not \\$(x)\n";
  for (const quoted of ["'EOF'", '"EOF"', "\\EOF", "E'O'F"]) {
    const delimiter = quoted.replace(/['"\\]/g, "");
    expect(splitCommand(`cat <<${quoted}\n${body}${delimiter}`).substitutions).toEqual([]);
  }
  expect(splitCommand(`cat <<EOF\n${body}EOF`).substitutions).toEqual(["lr ui", "lr status"]);
  expect(splitCommand("cat <<EOF\n$(x\nEOF").unterminated).toBe(true);
});

test("command substitutions are scripts of their own", () => {
  const script = splitCommand(`echo $(lr ui) "at $(jj log -r '@' "x)") \`lr \\\`b\\\`\` "\`c\`"`);
  expect(script.substitutions).toEqual(["lr ui", `jj log -r '@' "x)"`, "lr `b`", "c"]);
  expect(script.commands[0]!.words[0]).toBe("echo");
  // Nested ones come out whole, to be split in turn.
  expect(splitCommand("a $(b $(c) (d))").substitutions).toEqual(["b $(c) (d)"]);
  expect(splitCommand("a $(b \\) c").substitutions).toEqual(["b \\) c"]);
  expect(splitCommand("a $((1 + (2))) b").substitutions).toEqual(["(1 + (2))"]);
});

test("process substitutions are scripts of their own", () => {
  const script = splitCommand("diff <(lr ui) x && tee >(lr review submit --as nick)");
  expect(script.commands.map((c) => c.words)).toEqual([
    ["diff", "<(lr ui)", "x"],
    ["tee", ">(lr review submit --as nick)"],
  ]);
  expect(script.substitutions).toEqual(["lr ui", "lr review submit --as nick"]);
});

test("a substitution is read as a script, so its quotes and heredocs don't hide its end", () => {
  // Claude Code's usual form for a commit message.
  const script = splitCommand(
    `jj describe -m "$(cat <<'EOF'\nit's done (mostly)\nEOF\n)" && lr ui # it's)`,
  );
  expect(script).toEqual({
    commands: [
      { words: ["jj", "describe", "-m", "$(cat <<'EOF'\nit's done (mostly)\nEOF\n)"], stdin: [] },
      { words: ["lr", "ui"], stdin: [] },
    ],
    substitutions: ["cat <<'EOF'\nit's done (mostly)\nEOF\n"],
    unterminated: false,
  });
  expect(splitCommand("a $(echo ')' \"(\" # )\n)").substitutions).toEqual([`echo ')' "(" # )\n`]);
});

test("unterminated quotes and substitutions run to the end, and say so", () => {
  for (const text of [`a "b`, "a 'b", "a $'b", "a $(b", "a `b", "a $(cat <<EOF\n)"]) {
    expect([text, splitCommand(text).unterminated]).toEqual([text, true]);
  }
  expect(words(`lr reply 3 "lr ui`)).toEqual([["lr", "reply", "3", "lr ui"]]);
  expect(words("a 'b")).toEqual([["a", "b"]]);
  expect(words("a $'b")).toEqual([["a", "b"]]);
  expect(splitCommand("a $(b").substitutions).toEqual(["b"]);
  expect(splitCommand("a `b").substitutions).toEqual(["b"]);
  expect(words("a \\")).toEqual([["a", ""]]);
});
