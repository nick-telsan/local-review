import { Fragment, type MouseEvent, useEffect, useState } from "react";
import { type DiffLine, type FileDiff, filePath } from "../patch.ts";
import type { DraftComment, Placement, ThreadView } from "../ui/api.ts";
import { CommentForm } from "./CommentForm.tsx";
import { DraftCard } from "./Draft.tsx";
import { draftsOn, useReview } from "./review.tsx";
import { ThreadCard } from "./Thread.tsx";

/** Diffs longer than this start collapsed. */
const COLLAPSE_LINES = 800;

type Side = "old" | "new";
type OnLines = Extract<Placement, { on: "line" }>;
type Item =
  | { kind: "thread"; thread: ThreadView; at: OnLines }
  | { kind: "draft"; draft: DraftComment; at: OnLines };

/** Lines picked for a new comment: `anchor` is where the pick started, `head` where it is now. */
interface Selection {
  side: Side;
  anchor: number;
  head: number;
}

const lineOn = (l: DiffLine, side: Side) => (side === "old" ? l.oldLine : l.newLine);
const range = (s: Selection): [number, number] => [
  Math.min(s.anchor, s.head),
  Math.max(s.anchor, s.head),
];

export function FileDiffView({
  file,
  change,
  threads,
}: {
  file: FileDiff;
  change: string;
  threads: ThreadView[];
}) {
  const review = useReview();
  const path = filePath(file);
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount <= COLLAPSE_LINES);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    addEventListener("mouseup", stop);
    return () => removeEventListener("mouseup", stop);
  }, [dragging]);

  const onThisFile = (p: OnLines) => p.path === (p.side === "new" ? file.newPath : file.oldPath);
  const items: Item[] = [
    ...threads.flatMap((t): Item[] =>
      t.placement.on === "line" && onThisFile(t.placement)
        ? [{ kind: "thread", thread: t, at: t.placement }]
        : [],
    ),
    ...draftsOn(review.drafts, "line", (p) => p.changeId === change && onThisFile(p)).map(
      (d): Item => ({ kind: "draft", draft: d, at: d.placement }),
    ),
  ];

  // Each comment shows after the last line it covers, on its side; the rest, above the diff.
  const rows = file.hunks.flatMap((h) => h.lines);
  const after = new Map<DiffLine, Item[]>();
  const elsewhere: Item[] = [];
  for (const item of items) {
    const row = rows.find((l) => lineOn(l, item.at.side) === item.at.lines[1]);
    if (row) after.set(row, [...(after.get(row) ?? []), item]);
    else elsewhere.push(item);
  }

  /** The text of new-side lines a..b, if the diff shows them all (what a suggestion replaces). */
  const textOf = (side: Side, [a, b]: [number, number]): string | null => {
    if (side === "old") return null;
    const lines = rows.filter((l) => l.newLine !== null && l.newLine >= a && l.newLine <= b);
    return lines.length === b - a + 1 ? lines.map((l) => l.text).join("\n") : null;
  };

  const pick = (side: Side, n: number, extend: boolean) => {
    setSelection(
      extend && selection?.side === side ? { ...selection, head: n } : { side, anchor: n, head: n },
    );
  };
  const numberCell = (l: DiffLine, side: Side) => {
    const n = lineOn(l, side);
    if (n === null || !review.canReview) return <td className="num">{n ?? ""}</td>;
    return (
      <td className="num">
        <button
          type="button"
          className="num-button"
          title="Comment on this line (drag or shift-click for several)"
          onMouseDown={(e: MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault(); // no text selection while dragging
            pick(side, n, e.shiftKey);
            setDragging(true);
          }}
          onMouseEnter={() => {
            if (dragging && selection?.side === side) setSelection({ ...selection, head: n });
          }}
          // Keyboard activation (a mouse click was handled on mousedown).
          onClick={(e) => e.detail === 0 && pick(side, n, e.shiftKey)}
        >
          {n}
        </button>
      </td>
    );
  };

  const picked = selection && range(selection);
  const isPicked = (l: DiffLine) => {
    if (!selection || !picked) return false;
    const n = lineOn(l, selection.side);
    return n !== null && n >= picked[0] && n <= picked[1];
  };
  const isCommented = (l: DiffLine) =>
    items.some((i) => {
      const n = lineOn(l, i.at.side);
      return n !== null && n >= i.at.lines[0] && n <= i.at.lines[1];
    });
  const formAfter =
    selection && picked && !dragging
      ? rows.find((l) => lineOn(l, selection.side) === picked[1])
      : undefined;

  const renderItem = (item: Item) =>
    item.kind === "thread" ? (
      <ThreadCard key={`t${item.thread.id}`} thread={item.thread} />
    ) : (
      <DraftCard
        key={item.draft.id}
        draft={item.draft}
        suggestFrom={textOf(item.at.side, item.at.lines)}
      />
    );

  return (
    <section className="file" id={`file-${encodeURIComponent(path)}`}>
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
            <div className="thread-list outside">{elsewhere.map(renderItem)}</div>
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
                          <td className="code">
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
                              <div className="thread-list">{after.get(l)!.map(renderItem)}</div>
                            </td>
                          </tr>
                        )}
                        {formAfter === l && selection && picked && (
                          <tr className="inline-threads">
                            <td colSpan={3}>
                              <div className="thread draft">
                                <CommentForm
                                  key={`${selection.side}:${picked.join("-")}`}
                                  suggestFrom={textOf(selection.side, picked)}
                                  submitLabel="Add to review"
                                  onSubmit={async (v) => {
                                    await review.add({
                                      change,
                                      path: (selection.side === "new"
                                        ? file.newPath
                                        : file.oldPath)!,
                                      lines: picked,
                                      side: selection.side,
                                      ...v,
                                    });
                                    setSelection(null);
                                  }}
                                  onCancel={() => setSelection(null)}
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
