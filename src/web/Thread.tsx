import { useState } from "react";
import type { ReplyAction } from "../commands/thread.ts";
import type { Anchor, Entry } from "../model.ts";
import type { ThreadView } from "../ui/api.ts";
import { ApiError, send } from "./api.ts";
import { Markdown } from "./Markdown.tsx";
import { useReview } from "./review.tsx";
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
const lines = (l: [number, number] | null) =>
  l === null ? "" : `, ${l[0] === l[1] ? "line" : "lines"} ${range(l)}`;

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
      return `message of ${short(a.changeId)}${lines(a.lines)}`;
    case "code":
      return `${a.path}:${range(a.lines)}${a.side === "old" ? " (old side)" : ""} @ ${short(a.changeId)}`;
    case "final":
      return `final commit ${a.groupId}${lines(a.lines)}`;
    case "pr_body":
      return `the PR body${lines(a.lines)}`;
    case "plan":
      return `plan v${a.version}${lines(a.lines)}`;
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
    // Focusable, so `n`/`p` can select it and Tab goes on to its buttons.
    <article className={`thread thread-${t.status}`} id={`thread-${t.id}`} tabIndex={-1}>
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
      <ThreadReply thread={t} />
    </article>
  );
}

const ACTION_LABEL: Record<ReplyAction, string> = {
  resolve: "Resolve",
  reopen: "Reopen",
  accept: "Accept",
  dismiss: "Dismiss",
  addressed: "Mark addressed",
};
const ACTION_ORDER: ReplyAction[] = ["accept", "resolve", "reopen", "dismiss", "addressed"];

/** Reply, and the status changes the actor may make; a reply's text goes along with an action. */
function ThreadReply({ thread: t }: { thread: ThreadView }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = useReview().view.feature.slug;

  const reply = async (action: ReplyAction | null) => {
    setBusy(true);
    setError(null);
    try {
      await send("POST", `/features/${encodeURIComponent(slug)}/threads/${t.id}/replies`, {
        action,
        body: body.trim() || null,
      });
      setBody("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const actions = ACTION_ORDER.filter((a) => t.actions.includes(a));

  return (
    <footer className="thread-reply">
      {open ? (
        <textarea
          // biome-ignore lint/a11y/noAutofocus: opened by clicking Reply
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) void reply(null);
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Reply"
          rows={2}
          aria-label="Reply"
        />
      ) : null}
      <div className="form-row">
        {open ? (
          <button
            type="button"
            className="primary"
            disabled={busy || !body.trim()}
            onClick={() => void reply(null)}
          >
            Reply
          </button>
        ) : (
          <button type="button" onClick={() => setOpen(true)} data-shortcut="reply">
            Reply…
          </button>
        )}
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            disabled={busy}
            onClick={() => void reply(a)}
            title={body.trim() ? "Sends your reply too" : undefined}
          >
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
    </footer>
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
      {e.body && <Markdown text={e.body} breaks className="body" />}
      {e.suggestion !== null && (
        <figure className="suggestion">
          <figcaption>Suggested change</figcaption>
          <pre>{e.suggestion}</pre>
        </figure>
      )}
    </li>
  );
}
