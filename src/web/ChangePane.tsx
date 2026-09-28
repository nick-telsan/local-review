import type { ChangeSnapshot } from "../model.ts";
import { type FileDiff, filePath } from "../patch.ts";
import type { ChangeView, RoundView, SinceChange, ThreadView } from "../ui/api.ts";
import { useApi } from "./api.ts";
import { FileDiffView, onFile } from "./Diff.tsx";
import { AddComment, DraftCard, DraftList } from "./Draft.tsx";
import { threadChange } from "./RoundPage.tsx";
import { draftsOn, useReview } from "./review.tsx";
import { Link } from "./router.tsx";
import { useSince } from "./since.tsx";
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
  const review = useReview();
  const since = useSince();
  const compared = since?.on ? since.change(change.changeId) : undefined;
  // A changed change shows its interdiff; the rest, their whole diff (an added change's is new).
  const interdiff = compared?.status === "changed" && compared.note === null;
  const comparing = since?.on && !since.view && !since.error;
  const { data, error } = useApi<ChangeView>(
    interdiff || comparing
      ? null
      : `/features/${encodeURIComponent(view.feature.slug)}/rounds/${view.round.n}/changes/${change.changeId}`,
  );
  const files: FileDiff[] | null = interdiff ? compared.files : (data?.files ?? null);
  const threads = view.threads.filter((t) => threadChange(t) === change.changeId);
  const on = (kind: ThreadView["placement"]["on"]) =>
    threads.filter((t) => t.placement.on === kind);
  const phase = view.phases.find((p) => p.id === change.phaseId);
  const checks = view.checks.filter((r) => r.changeId === change.changeId);
  const href = since?.href ?? ((path: string) => path);
  const i = view.round.changes.indexOf(change);
  const prev = view.round.changes[i - 1];
  const next = view.round.changes[i + 1];
  const [, ...body] = change.description.trimEnd().split("\n");

  // Line comments on files the diff doesn't show (e.g. lines an interdiff leaves out) go with
  // the change's other comments.
  const shown = (p: Extract<ThreadView["placement"], { on: "line" }>) =>
    files === null || files.some((f) => onFile(f, p));
  const unshownThreads = on("line").filter((t) => t.placement.on === "line" && !shown(t.placement));
  const unshownDrafts = draftsOn(
    review.drafts,
    "line",
    (p) => p.changeId === change.changeId && !shown(p),
  );

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
        {compared && since && <SinceNote change={compared} from={since.from} />}
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
        {compared?.message && since && (
          <div className="message-diff">
            <h3 className="muted">Edited since round {since.from}</h3>
            <PlainDiff file={compared.message} />
          </div>
        )}
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
          {[...on("aside"), ...unshownThreads].map((t) => (
            <ThreadCard key={t.id} thread={t} showAnchor />
          ))}
          {unshownDrafts.map((d) => (
            <DraftCard key={d.id} draft={d} />
          ))}
        </div>
        <DraftList
          drafts={draftsOn(review.drafts, "change", (p) => p.changeId === change.changeId)}
        />
        <AddComment label="Comment on this change" target={{ change: change.changeId }} />
        {!review.canReview &&
          on("change").length + on("aside").length + unshownThreads.length === 0 && (
            <p className="empty">No comments.</p>
          )}
      </section>

      <section>
        {interdiff && since ? (
          <>
            <h2>
              Changed since round {since.from}{" "}
              <span className="muted">({compared.files.length})</span>
            </h2>
            <p className="muted diff-note">
              How this change's diff changed. The new side is this round's, and takes comments; the
              old side is round {since.from}'s version, rebased.{" "}
              <Link to={location.pathname}>Show the whole diff</Link>
            </p>
          </>
        ) : (
          <h2>
            Files <span className="muted">({change.stats.files})</span>
          </h2>
        )}
        {error && <ErrorBox error={error} />}
        {!files && !error && <Loading />}
        {files && files.length === 0 && (
          <p className="empty">{interdiff ? "Only the message changed." : "No files changed."}</p>
        )}
        {files && files.length > 1 && (
          <ul className="file-index">
            {files.map((f) => (
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
        {files?.map((f) => (
          <FileDiffView
            key={`${interdiff ? "since" : "all"}:${filePath(f)}`}
            file={f}
            change={change.changeId}
            threads={on("line")}
            sides={interdiff ? ["new"] : undefined}
          />
        ))}
      </section>

      <nav className="change-nav">
        {prev ? (
          <Link to={href(`${base}/c/${prev.changeId}`)}>← {subject(prev.description)}</Link>
        ) : (
          <span />
        )}
        {next && <Link to={href(`${base}/c/${next.changeId}`)}>{subject(next.description)} →</Link>}
      </nav>
    </article>
  );
}

/** How the change compares with the earlier round. */
function SinceNote({ change: c, from }: { change: SinceChange; from: number }) {
  const notes: string[] = [];
  if (c.movedFromPhase !== null) notes.push(`moved from phase ${c.movedFromPhase}`);
  if (c.conflicted) notes.push("conflicted");
  if (c.note) notes.push(c.note);
  const what =
    c.status === "added"
      ? `New since round ${from}.`
      : c.status === "unchanged"
        ? `Unchanged since round ${from}: its diff and message are the same.`
        : `Changed since round ${from}.`;
  return (
    <p className={`since-note since-${c.status}`}>
      {what}
      {notes.length > 0 && ` (${notes.join("; ")})`}
    </p>
  );
}

/** A diff to read, not comment on, like a message edit. */
function PlainDiff({ file }: { file: FileDiff }) {
  return (
    <table className="diff plain-diff">
      <tbody>
        {file.hunks.flatMap((h) =>
          h.lines.map((l) => (
            <tr key={`${l.oldLine ?? ""}:${l.newLine ?? ""}`} className={`line ${l.kind}`}>
              <td className="code">
                <span className="sign">
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                </span>
                {l.text}
              </td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}
