import { Fragment, type ReactNode, useState } from "react";
import type { DraftComment, DraftCommentInput, ThreadView } from "../ui/api.ts";
import { CommentForm } from "./CommentForm.tsx";
import { AddComment, DraftCard } from "./Draft.tsx";
import { Markdown } from "./Markdown.tsx";
import { useLinePicker } from "./picker.ts";
import { useReview } from "./review.tsx";
import { ThreadCard } from "./Thread.tsx";

type Item = { kind: "thread"; thread: ThreadView } | { kind: "draft"; draft: DraftComment };

const linesOf = (i: Item): [number, number] | null => {
  const p = i.kind === "thread" ? i.thread.placement : i.draft.placement;
  return "lines" in p ? p.lines : null;
};

const range = ([a, b]: [number, number]) => (a === b ? `line ${a}` : `lines ${a}–${b}`);

/**
 * A text reviewed line by line: a commit message, a final commit's message, or the PR body.
 * Comments on lines show after the last one; comments on the whole text, below it. Markdown (the
 * PR body) can also be read rendered, with every comment below it.
 */
export function TextLines({
  text,
  threads,
  drafts,
  target,
  addLabel,
  className,
  markdown = false,
}: {
  text: string;
  threads: ThreadView[];
  drafts: DraftComment[];
  /** What a new comment is on, in review-file form (without its lines). */
  target: Omit<DraftCommentInput, "body">;
  addLabel: string;
  className?: string;
  /** It's markdown, which can be previewed; as a PR description, newlines are line breaks. */
  markdown?: boolean;
}) {
  const review = useReview();
  const picker = useLinePicker<"text">();
  // Lines while it takes comments, which go on lines; rendered once it's just for reading.
  const [preview, setPreview] = useState(markdown && !review.canReview);
  const lines = text.replace(/\n$/, "").split("\n");

  const items: Item[] = [
    ...threads.map((thread): Item => ({ kind: "thread", thread })),
    ...drafts.map((draft): Item => ({ kind: "draft", draft })),
  ];
  // An outdated thread's lines were in text that has since changed: list it with its snippet.
  const inline = (i: Item) => {
    const at = linesOf(i);
    return (
      at !== null &&
      at[1] <= lines.length &&
      !(i.kind === "thread" && i.thread.anchorState === "outdated")
    );
  };
  const after = (n: number) => items.filter((i) => inline(i) && linesOf(i)![1] === n);
  const below = items.filter((i) => !inline(i));
  const textOf = ([a, b]: [number, number]) => lines.slice(a - 1, b).join("\n");

  const render = (i: Item, showAnchor = false): ReactNode => {
    const at = linesOf(i);
    return i.kind === "thread" ? (
      <ThreadCard key={`t${i.thread.id}`} thread={i.thread} showAnchor={showAnchor} />
    ) : (
      <DraftCard
        key={i.draft.id}
        draft={i.draft}
        suggestFrom={at && textOf(at)}
        where={showAnchor && at ? range(at) : undefined}
      />
    );
  };
  const toggle = markdown && (
    <fieldset className="segmented text-view" aria-label="How to show it">
      {(["Lines", "Preview"] as const).map((label) => {
        const chosen = (label === "Preview") === preview;
        return (
          <button
            key={label}
            type="button"
            className={chosen ? "chosen" : undefined}
            aria-pressed={chosen}
            onClick={() => setPreview(label === "Preview")}
          >
            {label}
          </button>
        );
      })}
    </fieldset>
  );

  if (preview) {
    return (
      <>
        {toggle}
        <Markdown text={text} breaks className="text-preview" />
        {items.length > 0 && (
          <div className="thread-list">
            {items.map((item) => render(item, linesOf(item) !== null))}
          </div>
        )}
        <AddComment label={addLabel} target={target} />
      </>
    );
  }
  const pending = picker.open;
  const commented = (n: number) =>
    items.some((i) => {
      const at = inline(i) ? linesOf(i) : null;
      return at !== null && n >= at[0] && n <= at[1];
    });

  return (
    <>
      {toggle}
      <table className={`diff text-lines ${className ?? ""}`}>
        <colgroup>
          <col className="num-col" />
          <col />
        </colgroup>
        <tbody>
          {lines.map((line, i) => {
            const n = i + 1;
            return (
              <Fragment key={n}>
                <tr
                  className={`line${commented(n) ? " commented" : ""}${
                    picker.isPicked("text", n) ? " picked" : ""
                  }`}
                >
                  <td className="num">
                    {review.canReview ? (
                      <button type="button" className="num-button" {...picker.button("text", n)}>
                        {n}
                      </button>
                    ) : (
                      n
                    )}
                  </td>
                  <td className="code">{line}</td>
                </tr>
                {after(n).length > 0 && (
                  <tr className="inline-threads">
                    <td colSpan={2}>
                      <div className="thread-list">{after(n).map((item) => render(item))}</div>
                    </td>
                  </tr>
                )}
                {pending?.lines[1] === n && (
                  <tr className="inline-threads">
                    <td colSpan={2}>
                      <div className="thread draft">
                        <CommentForm
                          {...picker.form(textOf(pending.lines))}
                          submitLabel="Add to review"
                          onSubmit={async (v) => {
                            await review.add({ ...target, lines: pending.lines, ...v });
                            picker.clear();
                          }}
                          onCancel={picker.clear}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {below.length > 0 && (
        <div className="thread-list">
          {below.map((item) => render(item, linesOf(item) !== null))}
        </div>
      )}
      <AddComment label={addLabel} target={target} />
    </>
  );
}
