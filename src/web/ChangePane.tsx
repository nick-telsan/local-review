import type { ChangeSnapshot } from "../model.ts";
import { filePath } from "../patch.ts";
import type { ChangeView, RoundView, ThreadView } from "../ui/api.ts";
import { useApi } from "./api.ts";
import { FileDiffView } from "./Diff.tsx";
import { AddComment, DraftList } from "./Draft.tsx";
import { threadChange } from "./RoundPage.tsx";
import { draftsOn, useReview } from "./review.tsx";
import { Link } from "./router.tsx";
import { ThreadCard, ThreadList } from "./Thread.tsx";
import { CheckIcon, ErrorBox, Loading, short, subject } from "./ui.tsx";

export function ChangePane({
  view,
  change,
  base,
}: {
  view: RoundView;
  change: ChangeSnapshot;
  base: string;
}) {
  const { data, error } = useApi<ChangeView>(
    `/features/${encodeURIComponent(view.feature.slug)}/rounds/${view.round.n}/changes/${change.changeId}`,
  );
  const review = useReview();
  const threads = view.threads.filter((t) => threadChange(t) === change.changeId);
  const on = (kind: ThreadView["placement"]["on"]) =>
    threads.filter((t) => t.placement.on === kind);
  const phase = view.phases.find((p) => p.id === change.phaseId);
  const checks = view.checks.filter((r) => r.changeId === change.changeId);
  const i = view.round.changes.indexOf(change);
  const prev = view.round.changes[i - 1];
  const next = view.round.changes[i + 1];
  const [, ...body] = change.description.trimEnd().split("\n");

  return (
    <article className="change-pane">
      <header className="change-head">
        <h1>{subject(change.description)}</h1>
        <p className="muted">
          <span className="mono">{short(change.changeId)}</span> · commit{" "}
          <span className="mono">{short(change.commitId)}</span>
          {phase && ` · phase ${phase.id}: ${phase.title}`}
          {change.bookmarks.map((b) => (
            <span key={b} className="bookmark mono">
              {b}
            </span>
          ))}
          {change.conflicted && <span className="flag conflict"> ⚠ conflicted</span>}
          {change.empty && <span className="flag"> empty</span>}
        </p>
        {checks.length > 0 && (
          <p className="change-checks">
            {checks.map((r) => (
              <span key={r.id} className="check-chip">
                <CheckIcon run={r} /> {r.check}
              </span>
            ))}
          </p>
        )}
      </header>

      <section className="message-section">
        <h2>Message</h2>
        <pre className="message">
          <strong>{subject(change.description)}</strong>
          {body.length > 0 && `\n${body.join("\n")}`}
        </pre>
        <ThreadList threads={on("message")} />
        <DraftList
          drafts={draftsOn(review.drafts, "message", (p) => p.changeId === change.changeId)}
        />
        <AddComment
          label="Comment on the message"
          target={{ change: change.changeId, message: true }}
        />
      </section>

      <section>
        <h2>On this change</h2>
        <ThreadList threads={on("change")} />
        <div className="thread-list">
          {on("aside").map((t) => (
            <ThreadCard key={t.id} thread={t} showAnchor />
          ))}
        </div>
        <DraftList
          drafts={draftsOn(review.drafts, "change", (p) => p.changeId === change.changeId)}
        />
        <AddComment label="Comment on this change" target={{ change: change.changeId }} />
        {!review.canReview && on("change").length + on("aside").length === 0 && (
          <p className="empty">No comments.</p>
        )}
      </section>

      <section>
        <h2>
          Files <span className="muted">({change.stats.files})</span>
        </h2>
        {error && <ErrorBox error={error} />}
        {!data && !error && <Loading />}
        {data && data.files.length === 0 && <p className="empty">No files changed.</p>}
        {data && data.files.length > 1 && (
          <ul className="file-index">
            {data.files.map((f) => (
              <li key={filePath(f)}>
                <a href={`#file-${encodeURIComponent(filePath(f))}`} className="mono">
                  {filePath(f)}
                </a>{" "}
                <span className="stat-add">+{f.added}</span>{" "}
                <span className="stat-del">−{f.removed}</span>
              </li>
            ))}
          </ul>
        )}
        {data?.files.map((f) => (
          <FileDiffView key={filePath(f)} file={f} change={change.changeId} threads={on("line")} />
        ))}
      </section>

      <nav className="change-nav">
        {prev ? (
          <Link to={`${base}/c/${prev.changeId}`}>← {subject(prev.description)}</Link>
        ) : (
          <span />
        )}
        {next && <Link to={`${base}/c/${next.changeId}`}>{subject(next.description)} →</Link>}
      </nav>
    </article>
  );
}
