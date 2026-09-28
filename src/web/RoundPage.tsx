import type { ChangeSnapshot, Phase, ThreadStatus } from "../model.ts";
import type { PlanView, RoundView, ThreadView } from "../ui/api.ts";
import { send, useApi } from "./api.ts";
import { ChangePane } from "./ChangePane.tsx";
import { AddComment, DraftList } from "./Draft.tsx";
import { PlanPane, planPath } from "./PlanPane.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { draftsOn, makeReview, ReviewContext, useReview } from "./review.tsx";
import { Link } from "./router.tsx";
import { type Since, SinceBar, SinceProvider, useSinceFor } from "./since.tsx";
import { TextLines } from "./TextLines.tsx";
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

export function RoundPage({
  slug,
  n,
  change,
  plan,
}: {
  slug: string;
  n: string;
  change: string | null;
  plan: boolean;
}) {
  const { data, error } = useApi<RoundView>(
    `/features/${encodeURIComponent(slug)}/rounds/${encodeURIComponent(n)}`,
  );
  const since = useSinceFor(data);
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
    <ReviewContext.Provider value={makeReview(data)}>
      <SinceProvider value={since}>
        <TopBar slug={slug} view={data} />
        <div className="round-layout">
          <Sidebar view={data} base={base} selected={plan ? "plan" : change} since={since} />
          <main className="round-main">
            <SinceBar view={data} />
            {!data.latest && (
              <div className="banner">
                This is round {data.round.n}; round {data.rounds.at(-1)!.n} is the latest. Threads
                show where they were made in this round.{" "}
                <Link to={`/f/${encodeURIComponent(slug)}`}>Go to the latest round</Link>
              </div>
            )}
            <DraftBanners view={data} />
            {plan ? (
              <PlanPane view={data} base={base} />
            ) : change === null ? (
              <Overview view={data} base={base} />
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
      </SinceProvider>
    </ReviewContext.Provider>
  );
}

/** Drafts the actor can't submit from here: on another round, or on this one now that it's closed. */
function DraftBanners({ view }: { view: RoundView }) {
  const review = useReview();
  const slug = encodeURIComponent(view.feature.slug);
  return (
    <>
      {view.otherDrafts.map((n) => (
        <div key={n} className="banner">
          You have an unsubmitted review on round {n}.{" "}
          <Link to={`/f/${slug}/r/${n}`}>Go to round {n}</Link>
        </div>
      ))}
      {view.draft && !review.canReview && (
        <div className="banner">
          Your draft review of round {view.round.n} can't be submitted: the round is{" "}
          {view.round.status}. Copy anything you still need, then{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => void send("DELETE", `${review.path}/draft`)}
          >
            discard it
          </button>
          .
        </div>
      )}
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
      {view && <ReviewPanel />}
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
  since,
}: {
  view: RoundView;
  base: string;
  /** A change id, `plan`, or null for the overview. */
  selected: string | null;
  since: Since | null;
}) {
  const general = view.threads.filter((t) => threadChange(t) === null && isUnsettled(t)).length;
  const href = since?.href ?? ((path: string) => path);
  const compared = (id: string) => (since?.on ? since.change(id) : undefined);
  const removed = since?.on
    ? (since.view?.changes.filter((c) => c.status === "removed") ?? [])
    : [];
  return (
    <nav className="sidebar" aria-label="Stack">
      <Link to={href(base)} className={`side-item overview${selected === null ? " current" : ""}`}>
        <span>Overview</span>
        {general > 0 && <span className="count">{general}</span>}
      </Link>
      <Link
        to={href(`${base}/plan`)}
        className={`side-item overview${selected === "plan" ? " current" : ""}`}
      >
        <span>Plan</span>
        <span className="muted mono">v{view.round.planVersion}</span>
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
            const then = compared(c.changeId);
            // Since an earlier round, a changed change's stats are its interdiff's.
            const stats =
              then?.status === "changed" && then.note === null
                ? {
                    added: then.files.reduce((n, f) => n + f.added, 0),
                    removed: then.files.reduce((n, f) => n + f.removed, 0),
                  }
                : c.stats;
            return (
              <Link
                key={c.changeId}
                to={href(`${base}/c/${c.changeId}`)}
                className={`side-item change${selected === c.changeId ? " current" : ""}${
                  then ? ` since-${then.status}` : ""
                }`}
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
                  {then && <SinceMark status={then.status} />}
                  <span className="stat-add">+{stats.added}</span>
                  <span className="stat-del">−{stats.removed}</span>
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
      {removed.length > 0 && (
        <section className="side-phase">
          <h3>Removed since round {since!.from}</h3>
          {removed.map((c) => (
            <div key={c.changeId} className="side-item change since-removed">
              <span className="change-subject">{subject(c.description)}</span>
              <span className="change-meta">
                <span className="mono muted">{short(c.changeId)}</span>
                <span className="muted">
                  {c.squashedInto ? `squashed into ${short(c.squashedInto)}` : "abandoned"}
                </span>
              </span>
            </div>
          ))}
        </section>
      )}
    </nav>
  );
}

const SINCE_MARK = {
  changed: "changed",
  added: "new",
  unchanged: "same",
  removed: "removed",
} as const;

function SinceMark({ status }: { status: keyof typeof SINCE_MARK }) {
  return <span className={`since-mark since-mark-${status}`}>{SINCE_MARK[status]}</span>;
}

function Overview({ view, base }: { view: RoundView; base: string }) {
  const review = useReview();
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

      <PlanSummary view={view} base={base} />

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
        <ThreadList threads={general} />
        <DraftList drafts={draftsOn(review.drafts, "feature")} />
        {general.length === 0 && !review.canReview && <p className="empty">None.</p>}
        <AddComment label="Add a general comment" target={{}} />
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
  const review = useReview();
  const final = view.round.final!;
  const on = (groupId: string) =>
    view.threads.filter((t) => t.placement.on === "final" && t.placement.groupId === groupId);
  const pr = view.threads.filter((t) => t.placement.on === "pr_body");
  const changes = new Map(view.round.changes.map((c) => [c.changeId, c]));
  return (
    <>
      <section>
        <h2>Final commits</h2>
        {final.groups.map((g) => (
          <div key={g.id} className="final-group">
            <h3>
              Commit {g.id}{" "}
              <span className="muted">
                · squashes{" "}
                {g.changeIds
                  .map((id) => subject(changes.get(id)?.description ?? short(id)))
                  .join(", ")}
              </span>
            </h3>
            <TextLines
              className="message-lines"
              text={g.message}
              threads={on(g.id)}
              drafts={draftsOn(review.drafts, "final", (p) => p.groupId === g.id)}
              target={{ final: g.id }}
              addLabel={`Comment on commit ${g.id}'s whole message`}
            />
          </div>
        ))}
      </section>
      <section>
        <h2>PR body</h2>
        <TextLines
          text={final.prBody}
          threads={pr}
          drafts={draftsOn(review.drafts, "pr_body")}
          target={{ pr_body: true }}
          addLabel="Comment on the whole PR body"
        />
      </section>
    </>
  );
}

/** How many of the plan's tasks the round's changes say they implement. */
function PlanSummary({ view, base }: { view: RoundView; base: string }) {
  const { data } = useApi<PlanView>(planPath(view));
  const tasks = data?.coverage.phases.flatMap((p) => p.tasks) ?? [];
  const done = tasks.filter((t) => t.changeIds.length > 0).length;
  return (
    <p className="plan-summary">
      <Link to={`${base}/plan`}>Plan v{view.round.planVersion}</Link>
      {data && (
        <span className="muted">
          {" · "}
          {view.phases.length} phase{view.phases.length === 1 ? "" : "s"}
          {tasks.length > 0 &&
            (data.coverage.linked
              ? ` · ${done} of ${tasks.length} tasks named by a change`
              : ` · ${tasks.length} tasks, none named by a change yet`)}
          {data.coverage.unknownTasks.length + data.coverage.unphased.length > 0 &&
            " · some changes aren't in the plan"}
        </span>
      )}
    </p>
  );
}
