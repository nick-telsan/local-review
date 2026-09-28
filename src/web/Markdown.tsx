// Markdown from plans, comments, and the PR body, as GitHub-flavored markdown: tables, task lists,
// strikethrough, autolinks. react-markdown builds React elements and never renders the
// text's HTML, and its default URL check drops `javascript:` and the like.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // Don't fetch remote images: the page would tell their hosts it's open. Link to them instead.
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer" className="image-link">
        🖼 {alt || src}
      </a>
    ) : null,
};

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
