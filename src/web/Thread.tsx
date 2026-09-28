import type { Anchor, Entry } from "../model.ts";
import type { ThreadView } from "../ui/api.ts";
import { ActorName, Pill, short, Time } from "./ui.tsx";

export function ThreadList({ threads }: { threads: ThreadView[] }) {
  if (threads.length === 0) return null;
  return (
    <div className="thread-list">
      {threads.map((t) => (
        <ThreadCard key={t.id} thread={t} />
      ))}
    </div>
  );
}

const range = ([a, b]: [number, number]) => (a === b ? `${a}` : `${a}–${b}`);

/** Where a thread points, for threads not shown inline. */
export function describe(a: Anchor): string {
  switch (a.kind) {
    case "feature":
      return "the feature";
    case "phase":
      return `phase ${a.phaseId}`;
    case "change":
      return `change ${short(a.changeId)}`;
    case "message":
      return `message of ${short(a.changeId)}${a.lines ? `, lines ${range(a.lines)}` : ""}`;
    case "code":
      return `${a.path}:${range(a.lines)}${a.side === "old" ? " (old side)" : ""} @ ${short(a.changeId)}`;
    case "final":
      return `final commit ${a.groupId}${a.lines ? `, lines ${range(a.lines)}` : ""}`;
    case "pr_body":
      return `the PR body${a.lines ? `, lines ${range(a.lines)}` : ""}`;
  }
}

export function ThreadCard({
  thread: t,
  showAnchor = false,
}: {
  thread: ThreadView;
  /** Show where it points and the code it was on (for threads not shown inline). */
  showAnchor?: boolean;
}) {
  const snippet = "snippet" in t.anchor ? t.anchor.snippet : [];
  return (
    <article className={`thread thread-${t.status}`} id={`thread-${t.id}`}>
      <header className="thread-head">
        <a href={`#thread-${t.id}`} className="thread-id">
          #{t.id}
        </a>
        <Pill kind={t.status}>{t.status}</Pill>
        {t.severity && <Pill kind={t.severity}>{t.severity}</Pill>}
        {t.kind === "note" && <Pill kind="note">author's note</Pill>}
        {t.anchorState !== "current" && (
          <Pill kind={t.anchorState}>{t.anchorState === "moved" ? "moved" : "outdated"}</Pill>
        )}
        {showAnchor && <span className="muted mono thread-where">{describe(t.anchor)}</span>}
      </header>
      {showAnchor && snippet.length > 0 && <pre className="snippet">{snippet.join("\n")}</pre>}
      <ol className="entries">
        {t.entries.map((e) => (
          <EntryView key={e.id} entry={e} />
        ))}
      </ol>
    </article>
  );
}

const ACTION: Record<string, string> = {
  addressed: "marked this addressed",
  resolved: "resolved this",
  dismissed: "dismissed this",
  open: "reopened this",
};

function EntryView({ entry: e }: { entry: Entry }) {
  const change = e.statusChange;
  // Accepting a proposed comment also moves it to open.
  const action = change
    ? change.from === "proposed" && change.to === "open"
      ? "accepted this"
      : ACTION[change.to]
    : null;
  return (
    <li className="entry">
      <div className="entry-head">
        <ActorName actor={e.author} />
        {action && <span className="muted"> {action}</span>}
        <span className="muted">
          {" · "}
          <Time iso={e.createdAt} />
          {e.round !== null && ` · round ${e.round}`}
        </span>
      </div>
      {e.body && <div className="body">{e.body}</div>}
      {e.suggestion !== null && (
        <figure className="suggestion">
          <figcaption>Suggested change</figcaption>
          <pre>{e.suggestion}</pre>
        </figure>
      )}
    </li>
  );
}
