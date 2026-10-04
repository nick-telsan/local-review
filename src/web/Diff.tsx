import { Fragment, useState } from "react";
import { type DiffHunk, type DiffLine, type FileDiff, filePath } from "../patch.ts";
import type { DraftComment, Placement, ThreadView } from "../ui/api.ts";
import { CommentForm } from "./CommentForm.tsx";
import { DraftCard } from "./Draft.tsx";
import { useLinePicker } from "./picker.ts";
import { draftsOn, useReview } from "./review.tsx";
import { ThreadCard } from "./Thread.tsx";

/** Diffs longer than this start collapsed. */
const COLLAPSE_LINES = 800;

type Side = "old" | "new";
type OnLines = Extract<Placement, { on: "line" }>;

const BOTH: Side[] = ["old", "new"];

/** Whether a line comment is on `file`, by the path on its side. */
export const onFile = (file: FileDiff, p: OnLines) =>
  p.path === (p.side === "new" ? file.newPath : file.oldPath);
type Item =
  | { kind: "thread"; thread: ThreadView; at: OnLines }
  | { kind: "draft"; draft: DraftComment; at: OnLines };

const lineOn = (l: DiffLine, side: Side) => (side === "old" ? l.oldLine : l.newLine);

export function FileDiffView({
  file,
  change,
  threads,
  sides = BOTH,
}: {
  file: FileDiff;
  change: string;
  threads: ThreadView[];
  /**
   * The sides whose line numbers are the change's own diff's, so comments show and go there. An
   * interdiff's old side is an earlier commit, so there it's only the new side.
   */
  sides?: Side[];
}) {
  const review = useReview();
  const path = filePath(file);
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount <= COLLAPSE_LINES);
  const picker = useLinePicker<Side>();

  const items: Item[] = [
    ...threads.flatMap((t): Item[] =>
      t.placement.on === "line" && onFile(file, t.placement)
        ? [{ kind: "thread", thread: t, at: t.placement }]
        : [],
    ),
    ...draftsOn(review.drafts, "line", (p) => p.changeId === change && onFile(file, p)).map(
      (d): Item => ({ kind: "draft", draft: d, at: d.placement }),
    ),
  ];

  // Each comment shows after the last line it covers, on its side; the rest, above the diff.
  const rows = file.hunks.flatMap((h) => h.lines);
  const after = new Map<DiffLine, Item[]>();
  const elsewhere: Item[] = [];
  for (const item of items) {
    const row =
      sides.includes(item.at.side) &&
      rows.find((l) => lineOn(l, item.at.side) === item.at.lines[1]);
    if (row) after.set(row, [...(after.get(row) ?? []), item]);
    else elsewhere.push(item);
  }

  /** The text of new-side lines a..b, if the diff shows them all (what a suggestion replaces). */
  const textOf = (side: Side, [a, b]: [number, number]): string | null => {
    if (side === "old") return null;
    const lines = rows.filter((l) => l.newLine !== null && l.newLine >= a && l.newLine <= b);
    return lines.length === b - a + 1 ? lines.map((l) => l.text).join("\n") : null;
  };

  const numberCell = (l: DiffLine, side: Side) => {
    const n = lineOn(l, side);
    if (n === null || !review.canReview || !sides.includes(side)) {
      return <td className="num">{n ?? ""}</td>;
    }
    return (
      <td className="num">
        <button
          type="button"
          className="num-button"
          aria-label={`${side === "old" ? "Old" : "New"} line ${n}`}
          {...picker.button(side, n)}
        >
          {n}
        </button>
      </td>
    );
  };

  const pending = picker.open;
  const isPicked = (l: DiffLine) =>
    picker.isPicked("old", l.oldLine) || picker.isPicked("new", l.newLine);
  const isCommented = (l: DiffLine) =>
    items.some((i) => {
      if (!sides.includes(i.at.side)) return false;
      const n = lineOn(l, i.at.side);
      return n !== null && n >= i.at.lines[0] && n <= i.at.lines[1];
    });
  const formAfter = pending
    ? rows.find((l) => lineOn(l, pending.side) === pending.lines[1])
    : undefined;

  const renderItem = (item: Item, showAnchor = false) =>
    item.kind === "thread" ? (
      <ThreadCard key={`t${item.thread.id}`} thread={item.thread} showAnchor={showAnchor} />
    ) : (
      <DraftCard
        key={item.draft.id}
        draft={item.draft}
        suggestFrom={textOf(item.at.side, item.at.lines)}
      />
    );

  return (
    <section className="file" id={`file-${encodeURIComponent(path)}`} aria-label={path}>
      <header className="file-head">
        <button
          type="button"
          className="toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={open ? "Collapse" : "Expand"}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className={`file-status status-${file.status}`}>{file.status}</span>
        <span className="mono file-path">
          {file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : path}
        </span>
        <span className="spacer" />
        {items.length > 0 && <span className="count">{items.length}</span>}
        <span className="stat-add">+{file.added}</span>
        <span className="stat-del">−{file.removed}</span>
      </header>
      {open && (
        <>
          {file.mode && (
            <p className="file-note">
              Mode {file.mode.from} → {file.mode.to}
            </p>
          )}
          {file.binary && <p className="file-note">Binary file changed.</p>}
          {!file.binary && file.hunks.length === 0 && !file.mode && (
            <p className="file-note">Empty file.</p>
          )}
          {elsewhere.length > 0 && (
            <div className="thread-list outside">
              {elsewhere.map((item) => renderItem(item, true))}
            </div>
          )}
          {file.hunks.length > 0 && (
            <table className="diff">
              <colgroup>
                <col className="num-col" />
                <col className="num-col" />
                <col />
              </colgroup>
              <tbody>
                {file.hunks.map((h) => (
                  <Fragment key={`${h.oldStart}:${h.newStart}`}>
                    <tr className="hunk-head">
                      <td colSpan={3}>
                        @@ −{h.oldStart},{h.oldCount} +{h.newStart},{h.newCount} @@
                      </td>
                    </tr>
                    {h.lines.map((l) => (
                      <Fragment key={`${l.oldLine ?? ""}:${l.newLine ?? ""}`}>
                        <tr
                          className={`line ${l.kind}${isCommented(l) ? " commented" : ""}${
                            isPicked(l) ? " picked" : ""
                          }`}
                        >
                          {numberCell(l, "old")}
                          {numberCell(l, "new")}
                          <td className="code" data-testid="line-text">
                            <span className="sign">
                              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                            </span>
                            {l.text}
                            {l.noNewline && (
                              <span className="no-newline" title="No newline at end of file">
                                ⏎̸
                              </span>
                            )}
                          </td>
                        </tr>
                        {after.get(l) && (
                          <tr className="inline-threads">
                            <td colSpan={3}>
                              <div className="thread-list">
                                {after.get(l)!.map((item) => renderItem(item))}
                              </div>
                            </td>
                          </tr>
                        )}
                        {formAfter === l && pending && (
                          <tr className="inline-threads">
                            <td colSpan={3}>
                              <div className="thread draft">
                                <CommentForm
                                  {...picker.form(textOf(pending.side, pending.lines))}
                                  submitLabel="Add to review"
                                  onSubmit={async (v) => {
                                    await review.add({
                                      change,
                                      path: (pending.side === "new" ? file.newPath : file.oldPath)!,
                                      lines: pending.lines,
                                      side: pending.side,
                                      ...v,
                                    });
                                    picker.clear();
                                  }}
                                  onCancel={picker.clear}
                                />
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

/** A diff to read, not comment on, like a message edit or a plan revision. */
export function PlainDiff({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <table className="diff plain-diff">
      <tbody>
        {hunks.map((h, i) => (
          <Fragment key={`${h.oldStart}:${h.newStart}`}>
            {i > 0 && (
              <tr className="hunk-head">
                <td>⋯</td>
              </tr>
            )}
            {h.lines.map((l) => (
              <tr key={`${l.oldLine ?? ""}:${l.newLine ?? ""}`} className={`line ${l.kind}`}>
                <td className="code" data-testid="line-text">
                  <span className="sign">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                  </span>
                  {l.text}
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
