// Markdown from plans, comments, and the PR body, as GitHub-flavored markdown: tables, task lists,
// strikethrough, autolinks. react-markdown builds React elements and never renders the
// text's HTML, and its default URL check drops `javascript:` and the like. Fenced code in a
// language with a grammar is highlighted.
import { Suspense, use } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Tokens } from "./Code.tsx";
import { fenceLanguage, highlight, joinLines, type Lang } from "./highlight.ts";

const components: Components = {
  a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // Don't fetch remote images: the page would tell their hosts it's open. Link to them instead.
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer" className="image-link">
        🖼 {alt || src}
      </a>
    ) : null,
  // Inline code has no language, so only a fenced block is highlighted. It shows plain until then.
  code: ({ node: _, className, children, ...props }) => {
    const lang = fenceLanguage(/^language-(.+)/.exec(className ?? "")?.[1] ?? "");
    return (
      <code className={className} {...props}>
        {lang && typeof children === "string" ? (
          <Suspense fallback={children}>
            <Highlighted text={children} lang={lang} />
          </Suspense>
        ) : (
          children
        )}
      </code>
    );
  },
};

function Highlighted({ text, lang }: { text: string; lang: Lang }) {
  const lines = use(highlight(text, lang));
  return lines ? <Tokens tokens={joinLines(lines)} /> : text;
}

const DOCUMENT = [remarkGfm];
const COMMENT = [remarkGfm, remarkBreaks];

/**
 * `breaks`: each newline is a line break, as GitHub treats comments and PR descriptions (but not
 * `.md` files, like plans). Text written as plain lines then reads as it was written.
 */
export function Markdown({
  text,
  breaks = false,
  className,
}: {
  text: string;
  breaks?: boolean;
  className?: string;
}) {
  return (
    <div className={`markdown${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={breaks ? COMMENT : DOCUMENT} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
