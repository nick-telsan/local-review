// A small markdown renderer for plans: headings, paragraphs, lists, quotes, code, rules, and
// inline code, emphasis, and links. It builds React elements (never HTML), so text stays text.
import type { ReactNode } from "react";

export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{blocks(text.replace(/\r\n/g, "\n").split("\n"))}</div>;
}

const FENCE = /^\s*(```+|~~~+)\s*(\S*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line);

function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = out.length;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const end = lines.findIndex((l, k) => k > i && l.trim().startsWith(fence[1]!));
      const stop = end === -1 ? lines.length : end;
      out.push(
        <pre key={key} className="code-block">
          <code>{lines.slice(i + 1, stop).join("\n")}</code>
        </pre>,
      );
      i = stop + 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const Tag = `h${heading[1]!.length}` as "h1";
      out.push(<Tag key={key}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(<hr key={key} />);
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(QUOTE.exec(lines[i++]!)![1]!);
      out.push(<blockquote key={key}>{blocks(quoted)}</blockquote>);
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const { list, next } = listAt(lines, i, item[1]!.length, /\d/.test(item[2]!), key);
      out.push(list);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines[i]!))) {
      para.push(lines[i++]!.trim());
    }
    out.push(<p key={key}>{inline(para.join(" "))}</p>);
  }
  return out;
}

/** A list starting at line `start`, indented `indent`; returns it and the line after it. */
function listAt(lines: string[], start: number, indent: number, ordered: boolean, key: number) {
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const item = ITEM.exec(line);
    if (item && item[1]!.length === indent) {
      items.push([item[3]!]);
      i++;
      continue;
    }
    const indented = line.length - line.trimStart().length > indent;
    const blankThenMore =
      !line.trim() &&
      i + 1 < lines.length &&
      lines[i + 1]!.length - lines[i + 1]!.trimStart().length > indent;
    if (items.length && (indented && line.trim() ? true : blankThenMore)) {
      items.at(-1)!.push(line.slice(Math.min(line.length - line.trimStart().length, indent + 2)));
      i++;
      continue;
    }
    break;
  }
  const Tag = ordered ? "ol" : "ul";
  const list = (
    <Tag key={key}>
      {items.map((body, k) => {
        const task = /^\[([ xX])\]\s+/.exec(body[0]!);
        if (task) body[0] = body[0]!.slice(task[0].length);
        // A one-paragraph item stays inline; more becomes blocks.
        const content = body.length === 1 ? inline(body[0]!) : blocks(body);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: items have nothing else to key on
          <li key={k} className={task ? "task" : undefined}>
            {task && <span className="task-box">{task[1] === " " ? "☐" : "☑"} </span>}
            {content}
          </li>
        );
      })}
    </Tag>
  );
  return { list, next: i };
}

const INLINE =
  /(`+)(.+?)\1|\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*|(?<![\w])_(?!\s)(.+?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = out.length;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] ?? m[4]) out.push(<strong key={key}>{inline((m[3] ?? m[4])!)}</strong>);
    else if (m[5] ?? m[6]) out.push(<em key={key}>{inline((m[5] ?? m[6])!)}</em>);
    else {
      const href = m[8]!;
      out.push(
        /^(https?:|mailto:)/i.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {inline(m[7]!)}
          </a>
        ) : (
          <span key={key}>{inline(m[7]!)}</span>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
