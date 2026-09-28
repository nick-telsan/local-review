import type { ChangeSnapshot, Phase, ThreadStatus } from "../src/model.ts";
import type { RoundView, ThreadView } from "../src/ui/api.ts";
import { useApi } from "./api.ts";
import { ChangePane } from "./ChangePane.tsx";
import { Link } from "./router.tsx";
import { ThreadCard, ThreadList } from "./Thread.tsx";
import {
  ActorName,
  CheckIcon,
  ErrorBox,
  formatActor,
  Loading,
  Pill,
  short,
  subject,
  Time,
} from "./ui.tsx";

const UNSETTLED: ThreadStatus[] = ["proposed", "open", "addressed"];

export function isUnsettled(t: ThreadView): boolean {
  // A resolved note is just there to read, like `lr status` counts them.
  return UNSETTLED.includes(t.status);
}

/** The change a thread belongs with in the sidebar and change pane, if any. */
export function threadChange(t: ThreadView): string | null {
  const p = t.placement;
  return "changeId" in p ? p.changeId : null;
}

export function RoundPage({ slug, n, change }: { slug: string; n: string; change: string | null }) {
  const { data, error } = useApi<RoundView>(
    `/features/${encodeURIComponent(slug)}/rounds/${encodeURIComponent(n)}`,
  );
  if (error && !data) {
    return (
      <>
        <TopBar slug={slug} view={null} />
        <main className="page">
          <ErrorBox error={error} />
        </main>
      </>
    );
  }
  if (!data) return <Loading />;
  const base = `/f/${encodeURIComponent(slug)}/r/${data.round.n}`;
  const selected = change ? data.round.changes.find((c) => c.changeId === change) : undefined;

  return (
    <>
      <TopBar slug={slug} view={data} />
      <div className="round-layout">
        <Sidebar view={data} base={base} selected={change} />
        <main className="round-main">
          {!data.latest && (
            <div className="banner">
              This is round {data.round.n}; round {data.rounds.at(-1)!.n} is the latest. Threads
              show where they were made in this round.{" "}
              <Link to={`/f/${encodeURIComponent(slug)}`}>Go to the latest round</Link>
            </div>
          )}
          {change === null ? (
            <Overview view={data} />
          ) : selected ? (
            <ChangePane view={data} change={selected} base={base} />
          ) : (
            <p className="empty">
              Round {data.round.n} has no change {short(change)}.{" "}
              <Link to={base}>Back to the round</Link>
            </p>
          )}
        </main>
      </div>
    </>
  );
}

function TopBar({ slug, view }: { slug: string; view: RoundView | null }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        lr
      </Link>
      <span className="crumb">
        {view ? view.feature.title : slug}
        {view && <span className="mono muted"> {view.feature.slug}</span>}
      </span>
      {view && <Pill kind={view.feature.status}>{view.feature.status.replace("_", " ")}</Pill>}
      {view && (
        <nav className="rounds" aria-label="Rounds">
          {view.rounds.map((r) => (
            <Link
              key={r.n}
              to={`/f/${encodeURIComponent(slug)}/r/${r.n}`}
              className={`round-tab${r.n === view.round.n ? " current" : ""}`}
              title={`${r.kind} round, ${r.status}${r.verdict ? `, ${r.verdict.replace("_", " ")}` : ""}`}
            >
              {r.kind === "final" ? `Final ${r.n}` : `Round ${r.n}`}
              {r.verdict === "approved" && <span className="verdict-dot approved" />}
              {r.verdict === "changes_requested" && <span className="verdict-dot changes" />}
            </Link>
          ))}
        </nav>
      )}
      <span className="spacer" />
      {view && <span className="muted">as {formatActor(view.actor)}</span>}
    </header>
  );
}

/** Phases in plan order, each with its changes in stack order; then changes in no phase. */
export function byPhase(
  changes: ChangeSnapshot[],
  phases: Phase[],
): { phase: Phase | null; changes: ChangeSnapshot[] }[] {
  const groups = phases.map((phase) => ({
    phase: phase as Phase | null,
    changes: changes.filter((c) => c.phaseId === phase.id),
  }));
  const loose = changes.filter((c) => c.phaseId === null);
  if (loose.length) groups.push({ phase: null, changes: loose });
  return groups.filter((g) => g.changes.length > 0);
}

function Sidebar({
  view,
  base,
  selected,
}: {
  view: RoundView;
  base: string;
  selected: string | null;
}) {
  const general = view.threads.filter((t) => threadChange(t) === null && isUnsettled(t)).length;
  return (
    <nav className="sidebar" aria-label="Stack">
      <Link to={base} className={`side-item overview${selected === null ? " current" : ""}`}>
        <span>Overview</span>
        {general > 0 && <span className="count">{general}</span>}
      </Link>
      {byPhase(view.round.changes, view.phases).map(({ phase, changes }) => (
        <section key={phase?.id ?? "none"} className="side-phase">
          <h3 title={phase?.bookmark}>
            {phase ? (
              <>
                <span className="phase-id">{phase.id}</span> {phase.title}
              </>
            ) : (
              "No phase"
            )}
          </h3>
          {changes.map((c) => {
            const threads = view.threads.filter(
              (t) => threadChange(t) === c.changeId && isUnsettled(t),
            ).length;
            const checks = view.checks.filter((r) => r.changeId === c.changeId);
            return (
              <Link
                key={c.changeId}
                to={`${base}/c/${c.changeId}`}
                className={`side-item change${selected === c.changeId ? " current" : ""}`}
              >
                <span className="change-subject">
                  {c.conflicted && (
                    <span className="flag conflict" title="conflicted">
                      ⚠
                    </span>
                  )}
                  {subject(c.description)}
                </span>
                <span className="change-meta">
                  <span className="mono muted">{short(c.changeId)}</span>
                  <span className="stat-add">+{c.stats.added}</span>
                  <span className="stat-del">−{c.stats.removed}</span>
                  {checks.map((r) => (
                    <CheckIcon key={r.id} run={r} />
                  ))}
                  {threads > 0 && <span className="count">{threads}</span>}
                </span>
              </Link>
            );
          })}
        </section>
      ))}
    </nav>
  );
}

function Overview({ view }: { view: RoundView }) {
  const { round, feature } = view;
  const reviews = view.reviews.filter((r) => r.state === "submitted");
  const general = view.threads.filter((t) => t.placement.on === "feature");
  const gone = view.threads.filter((t) => t.placement.on === "gone");
  const byPhaseThreads = view.phases
    .map((p) => ({
      phase: p,
      threads: view.threads.filter(
        (t) => t.placement.on === "phase" && t.placement.phaseId === p.id,
      ),
    }))
    .filter((g) => g.threads.length > 0);
  const changeById = new Map(round.changes.map((c) => [c.changeId, c]));

  return (
    <div className="overview">
      <h1>{feature.title}</h1>
      {view.latest && (
        <p className="next">
          <strong>Next:</strong> {view.next}
        </p>
      )}
      <p className="muted round-meta">
        {round.kind === "final" ? "Final round" : "Round"} {round.n} · {round.status}
        {round.verdict && ` · ${round.verdict.replace("_", " ")}`} · opened by{" "}
        <ActorName actor={round.createdBy} /> <Time iso={round.createdAt} /> · plan v
        {round.planVersion} · {round.changes.length} changes on{" "}
        <span className="mono">{short(round.baseCommitId)}</span>
      </p>

      {round.final && <FinalRound view={view} />}

      <section>
        <h2>Reviews</h2>
        {reviews.length === 0 ? (
          <p className="empty">No reviews yet.</p>
        ) : (
          <ul className="reviews">
            {reviews.map((r) => (
              <li key={r.id} className="review">
                <div className="review-head">
                  <ActorName actor={r.reviewer} />
                  <Pill kind={r.verdict ?? "commented"}>
                    {(r.verdict ?? "commented").replace("_", " ")}
                  </Pill>
                  <span className="muted">
                    {view.threads.filter((t) => t.reviewId === r.id).length} comments ·{" "}
                    <Time iso={r.submittedAt ?? r.createdAt} />
                  </span>
                </div>
                {r.body && <div className="body">{r.body}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Checks</h2>
        {view.checks.length === 0 ? (
          <p className="empty">No checks ran for this round.</p>
        ) : (
          <table className="checks">
            <tbody>
              {view.checks.map((r) => (
                <tr key={r.id}>
                  <td>
                    <CheckIcon run={r} />
                  </td>
                  <td>{r.check}</td>
                  <td>
                    <span className="mono muted">{short(r.changeId)}</span>{" "}
                    {subject(changeById.get(r.changeId)?.description ?? "")}
                  </td>
                  <td className="muted">
                    {r.status}
                    {r.exitCode !== null && r.status !== "pass" && ` (exit ${r.exitCode})`}
                    {r.trigger === "manual" && " · by hand"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>General comments</h2>
        {general.length === 0 ? <p className="empty">None.</p> : <ThreadList threads={general} />}
      </section>

      {gone.length > 0 && (
        <section>
          <h2>On changes no longer in the stack</h2>
          <div className="thread-list">
            {gone.map((t) => (
              <ThreadCard key={t.id} thread={t} showAnchor />
            ))}
          </div>
        </section>
      )}

      {byPhaseThreads.map(({ phase, threads }) => (
        <section key={phase.id}>
          <h2>
            Phase {phase.id}: {phase.title}
          </h2>
          <ThreadList threads={threads} />
        </section>
      ))}
    </div>
  );
}

function FinalRound({ view }: { view: RoundView }) {
  const final = view.round.final!;
  const on = (groupId: string) =>
    view.threads.filter((t) => t.placement.on === "final" && t.placement.groupId === groupId);
  const pr = view.threads.filter((t) => t.placement.on === "pr_body");
  return (
    <>
      <section>
        <h2>Final commits</h2>
        {final.groups.map((g) => (
          <div key={g.id} className="final-group">
            <h3>
              {g.id} <span className="muted">· {g.changeIds.length} changes</span>
            </h3>
            <pre className="message">{g.message}</pre>
            <ThreadList threads={on(g.id)} />
          </div>
        ))}
      </section>
      <section>
        <h2>PR body</h2>
        <pre className="message">{final.prBody}</pre>
        <ThreadList threads={pr} />
      </section>
    </>
  );
}
