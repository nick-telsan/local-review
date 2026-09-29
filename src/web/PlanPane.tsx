import { useState } from "react";
import { diffLines } from "../linediff.ts";
import type { ChangeSnapshot, Phase } from "../model.ts";
import type { PhaseCoverage, PlanView, RoundView } from "../ui/api.ts";
import { useApi } from "./api.ts";
import { PlainDiff } from "./Diff.tsx";
import { AddComment, DraftList } from "./Draft.tsx";
import { Markdown } from "./Markdown.tsx";
import { draftsOn, useReview } from "./review.tsx";
import { Link } from "./router.tsx";
import { useSince } from "./since.tsx";
import { TextLines } from "./TextLines.tsx";
import { ThreadList } from "./Thread.tsx";
import { ActorName, ErrorBox, Loading, short, subject, Time } from "./ui.tsx";

export const planPath = (view: RoundView) =>
  `/features/${encodeURIComponent(view.feature.slug)}/rounds/${view.round.n}/plan`;

/** The plan the round was taken against, next to what the round implements; and its versions. */
export function PlanPane({ view, base }: { view: RoundView; base: string }) {
  const review = useReview();
  const { data, error } = useApi<PlanView>(planPath(view));
  const [chosen, setChosen] = useState<number | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const v = chosen ?? data.version;
  const shown = data.versions.find((x) => x.plan.version === v)!;
  const before = data.versions.find((x) => x.plan.version === v - 1);
  const latest = data.versions.at(-1)!.plan.version;
  const slug = encodeURIComponent(view.feature.slug);

  return (
    <article className="plan-pane">
      <header className="plan-head">
        <h1>Plan v{v}</h1>
        {data.versions.length > 1 && (
          <fieldset className="segmented" aria-label="Plan version">
            {data.versions.map(({ plan }) => (
              <button
                key={plan.version}
                type="button"
                className={plan.version === v ? "chosen" : undefined}
                aria-pressed={plan.version === v}
                onClick={() => setChosen(plan.version)}
              >
                v{plan.version}
                {plan.version === data.version && " · this round"}
              </button>
            ))}
          </fieldset>
        )}
      </header>
      <p className="muted">
        Written by <ActorName actor={shown.plan.createdBy} /> <Time iso={shown.plan.createdAt} />
        {shown.plan.respondsToRound !== null && (
          <>
            {" "}
            in response to{" "}
            <Link to={`/f/${slug}/r/${shown.plan.respondsToRound}`}>
              round {shown.plan.respondsToRound}
            </Link>
          </>
        )}
      </p>
      {v !== data.version && (
        <div className="banner">
          Round {view.round.n} was taken against plan v{data.version}: that's where to see what it
          implements, and to comment on phases.{" "}
          <button type="button" className="link-button" onClick={() => setChosen(data.version)}>
            Back to v{data.version}
          </button>
        </div>
      )}
      {v === data.version && latest > v && (
        <div className="banner">
          The plan was revised after this round.{" "}
          <button type="button" className="link-button" onClick={() => setChosen(latest)}>
            Read v{latest}
          </button>
        </div>
      )}

      <section>
        <h2>Phases and tasks</h2>
        {v === data.version && !data.coverage.linked && (
          <p className="muted">
            No change in this round names a task, so there's no task coverage to show. A commit
            links to a task with a <code>Plan-Task: 1.1</code> trailer in its message.
          </p>
        )}
        {shown.plan.phases.map((phase) => (
          <PhaseCard
            key={phase.id}
            phase={phase}
            view={view}
            base={base}
            coverage={
              v === data.version
                ? data.coverage.phases.find((p) => p.phaseId === phase.id)
                : undefined
            }
            linked={data.coverage.linked}
          />
        ))}
        {v === data.version && <NotInPlan view={view} base={base} coverage={data.coverage} />}
      </section>

      {before && (
        <details className="plan-diff">
          <summary>What changed from v{before.plan.version}</summary>
          <PlainDiff hunks={diffLines(before.text, shown.text)} />
        </details>
      )}

      <section>
        <h2>The plan</h2>
        {v === data.version ? (
          <TextLines
            text={shown.text}
            threads={view.threads.filter((t) => t.placement.on === "plan")}
            drafts={draftsOn(review.drafts, "plan")}
            target={{ plan: true }}
            addLabel="Comment on the whole plan"
            shortcut
            preview={{ text: shown.body, breaks: false }}
          />
        ) : (
          <Markdown text={shown.body} />
        )}
      </section>
    </article>
  );
}

function PhaseCard({
  phase,
  view,
  base,
  coverage,
  linked,
}: {
  phase: Phase;
  view: RoundView;
  base: string;
  /** How the round covers it; absent when reading another plan version. */
  coverage: PhaseCoverage | undefined;
  linked: boolean;
}) {
  const review = useReview();
  const threads = view.threads.filter(
    (t) => t.placement.on === "phase" && t.placement.phaseId === phase.id,
  );
  const changes = new Map(view.round.changes.map((c) => [c.changeId, c]));
  const chip = (id: string) => (
    <ChangeChip key={id} change={changes.get(id)!} base={base} phase={phase.id} />
  );

  return (
    <div className="phase-card">
      <h3>
        <span className="phase-id">{phase.id}</span> {phase.title}{" "}
        <span className="bookmark mono">{phase.bookmark}</span>
      </h3>
      {phase.doneWhen && (
        <p className="done-when">
          <strong>Done when:</strong> {phase.doneWhen}
        </p>
      )}
      {phase.tasks.length > 0 && (
        <ul className="tasks">
          {phase.tasks.map((task) => {
            const covered = coverage?.tasks.find((t) => t.task.id === task.id)?.changeIds ?? [];
            const mark = !coverage || !linked ? "·" : covered.length ? "✓" : "○";
            return (
              <li
                key={task.id}
                className={`task-row${coverage && linked && !covered.length ? " open" : ""}`}
              >
                <span className={`task-mark${covered.length ? " done" : ""}`}>{mark}</span>
                <span className="mono muted">{task.id}</span> {task.title}
                {covered.length > 0 && <span className="chips">{covered.map(chip)}</span>}
                {coverage && linked && covered.length === 0 && (
                  <span className="muted"> — no change names this task</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {coverage &&
        (coverage.changeIds.length === 0 ? (
          <p className="muted">No changes in this phase.</p>
        ) : (
          (!linked || coverage.untasked.length > 0) && (
            <p className="phase-changes">
              <span className="muted">
                {linked ? "Changes naming no task:" : "Changes in this phase:"}
              </span>{" "}
              {(linked ? coverage.untasked : coverage.changeIds).map(chip)}
            </p>
          )
        ))}
      {/* Phase comments are on the round's plan, so another version's phases don't take them. */}
      {coverage && (
        <>
          <ThreadList threads={threads} />
          <DraftList drafts={draftsOn(review.drafts, "phase", (p) => p.phaseId === phase.id)} />
          <AddComment label="Comment on this phase" target={{ phase: phase.id }} />
        </>
      )}
    </div>
  );
}

function ChangeChip({
  change,
  base,
  phase,
}: {
  change: ChangeSnapshot;
  base: string;
  /** The phase it's listed under: say so when it's in another. */
  phase?: number;
}) {
  const since = useSince();
  const path = `${base}/c/${change.changeId}`;
  return (
    <Link to={since?.href(path) ?? path} className="change-chip" title={change.description}>
      <span className="mono">{short(change.changeId)}</span> {subject(change.description)}
      {phase !== undefined && change.phaseId !== phase && (
        <span className="muted">
          {" "}
          ({change.phaseId === null ? "in no phase" : `in phase ${change.phaseId}`})
        </span>
      )}
    </Link>
  );
}

function NotInPlan({
  view,
  base,
  coverage,
}: {
  view: RoundView;
  base: string;
  coverage: PlanView["coverage"];
}) {
  if (coverage.unknownTasks.length === 0 && coverage.unphased.length === 0) return null;
  const change = (id: string) => view.round.changes.find((c) => c.changeId === id)!;
  return (
    <div className="phase-card not-in-plan">
      <h3>Not in the plan</h3>
      <ul className="tasks">
        {coverage.unknownTasks.map(({ changeId, taskId }) => (
          <li key={`${changeId}:${taskId}`} className="task-row">
            <span className="task-mark">?</span>
            <ChangeChip change={change(changeId)} base={base} /> names task{" "}
            <span className="mono">{taskId}</span>, which the plan doesn't have
          </li>
        ))}
        {coverage.unphased.map((id) => (
          <li key={id} className="task-row">
            <span className="task-mark">?</span>
            <ChangeChip change={change(id)} base={base} /> is past the last phase's bookmark
          </li>
        ))}
      </ul>
    </div>
  );
}
