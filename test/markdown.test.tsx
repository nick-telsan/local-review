import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/web/Markdown.tsx";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test("GitHub-flavored: tables, task lists, strikethrough, autolinks", () => {
  const out = html(
    [
      "| Phase | Risk |",
      "| --- | :-: |",
      "| 1 | `low` |",
      "",
      "- [x] done",
      "- [ ] not yet",
      "",
      "~~gone~~ and https://example.com",
    ].join("\n"),
  );
  expect(out).toContain("<table><thead><tr><th>Phase</th>");
  expect(out).toContain('<td style="text-align:center"><code>low</code></td>');
  expect(out).toContain('<input type="checkbox" disabled="" checked=""/> done');
  expect(out).toContain("<del>gone</del>");
  expect(out).toContain(
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>',
  );
});

test("an agent's text can't run script or load anything", () => {
  const out = html(
    [
      "<script>alert(1)</script>",
      '<img src="x" onerror="alert(1)">',
      "[click](javascript:alert(1))",
      "![chart](https://tracker.example/pixel.png)",
    ].join("\n\n"),
  );
  expect(out).not.toContain("<script");
  expect(out).not.toContain("<img");
  expect(out).not.toContain("javascript:");
  expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  // Images become links, so nothing is fetched until someone clicks.
  expect(out).toContain('<a href="https://tracker.example/pixel.png"');
  expect(out).toContain("🖼 chart</a>");
});

test("in comments and the PR body, each newline is a line break, as on GitHub", () => {
  const text = "Two things:\nfirst\nsecond";
  expect(renderToStaticMarkup(<Markdown text={text} />)).toContain(
    "<p>Two things:\nfirst\nsecond</p>",
  );
  expect(renderToStaticMarkup(<Markdown text={text} breaks className="body" />)).toBe(
    '<div class="markdown body"><p>Two things:<br/>\nfirst<br/>\nsecond</p></div>',
  );
});
