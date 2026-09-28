import { Fragment, useState } from "react";
import { type DiffLine, type FileDiff, filePath } from "../src/patch.ts";
import type { ThreadView } from "../src/ui/api.ts";
import { ThreadCard } from "./Thread.tsx";

/** Diffs longer than this start collapsed. */
const COLLAPSE_LINES = 800;

type LineThread = ThreadView & { placement: Extract<ThreadView["placement"], { on: "line" }> };

function isLineThread(t: ThreadView): t is LineThread {
  return t.placement.on === "line";
}

export function FileDiffView({ file, threads }: { file: FileDiff; threads: ThreadView[] }) {
  const path = filePath(file);
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount <= COLLAPSE_LINES);

  // A thread shows after the last line it covers, on the side it was made on.
  const mine = threads
    .filter(isLineThread)
    .filter((t) => t.placement.path === (t.placement.side === "new" ? file.newPath : file.oldPath));
  const at = new Map<string, LineThread[]>();
  const shown = new Set<number>();
  for (const h of file.hunks) {
    for (const l of h.lines) {
      for (const side of ["old", "new"] as const) {
        const n = side === "old" ? l.oldLine : l.newLine;
        if (n === null) continue;
        for (const t of mine) {
          if (t.placement.side === side && t.placement.lines[1] === n && !shown.has(t.id)) {
            shown.add(t.id);
            at.set(key(l), [...(at.get(key(l)) ?? []), t]);
          }
        }
      }
    }
  }
  // Comments on lines the diff doesn't show (lr lets reviewers comment on any line of the file).
  const elsewhere = mine.filter((t) => !shown.has(t.id));

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
        {mine.length > 0 && <span className="count">{mine.length}</span>}
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
              {elsewhere.map((t) => (
                <ThreadCard key={t.id} thread={t} showAnchor />
              ))}
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
                      <Fragment key={key(l)}>
                        <tr className={`line ${l.kind}${inRange(mine, l) ? " commented" : ""}`}>
                          <td className="num">{l.oldLine ?? ""}</td>
                          <td className="num">{l.newLine ?? ""}</td>
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
                        {at.get(key(l)) && (
                          <tr className="inline-threads">
                            <td colSpan={3}>
                              {at.get(key(l))!.map((t) => (
                                <ThreadCard key={t.id} thread={t} />
                              ))}
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

function key(l: DiffLine): string {
  return `${l.oldLine ?? ""}:${l.newLine ?? ""}`;
}

/** Whether a line is inside a comment's range, on the side the comment was made on. */
function inRange(threads: LineThread[], l: DiffLine): boolean {
  return threads.some((t) => {
    const n = t.placement.side === "old" ? l.oldLine : l.newLine;
    const [a, b] = t.placement.lines;
    return n !== null && n >= a && n <= b;
  });
}
