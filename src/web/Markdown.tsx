// Markdown from plans (and whatever else agents write), as GitHub-flavored markdown: tables, task
// lists, strikethrough, autolinks. react-markdown builds React elements and never renders the
// text's HTML, and its default URL check drops `javascript:` and the like.
import ReactMarkdown, { type Components } from "react-markdown";
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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
