// "Since round n": the round compared with an earlier one, change by change, like `lr diff`.
import { createContext, useContext } from "react";
import type { RoundView, SinceChange, SinceView } from "../ui/api.ts";
import { type ApiError, useApi } from "./api.ts";
import { navigate, useParam, usePath } from "./router.tsx";

export interface Since {
  /** The round compared with: `?since=`, else the actor's last review, else the one before. */
  from: number;
  /** Showing only what changed since `from`. */
  on: boolean;
  view: SinceView | null;
  error: ApiError | null;
  change(changeId: string): SinceChange | undefined;
  /** A link within the round that keeps the comparison on. */
  href(path: string): string;
}

const SinceContext = createContext<Since | null>(null);
export const SinceProvider = SinceContext.Provider;

/** The comparison, or null in round 1. */
export function useSince(): Since | null {
  return useContext(SinceContext);
}

/** Compare `view`'s round with an earlier one; fetched even when off, for the toggle's summary. */
export function useSinceFor(view: RoundView | null): Since | null {
  const param = useParam("since");
  const n = view?.round.n ?? 0;
  const asked = param !== null && /^\d+$/.test(param) ? Number(param) : null;
  const from = asked ?? view?.lastReviewed ?? n - 1;
  const { data, error } = useApi<SinceView>(
    view && n > 1
      ? `/features/${encodeURIComponent(view.feature.slug)}/rounds/${n}/since/${from}`
      : null,
  );
  if (!view || n <= 1) return null;
  const on = asked !== null;
  return {
    from,
    on,
    view: data,
    error,
    change: (id) => data?.changes.find((c) => c.changeId === id),
    href: (path) => (on ? `${path}?since=${from}` : path),
  };
}

const TALLY = ["changed", "added", "removed", "unchanged"] as const;

/** Switch between the whole round and what changed since an earlier one. */
export function SinceBar({ view }: { view: RoundView }) {
  const since = useSince();
  const path = usePath();
  if (!since) return null;
  const go = (from: number | null) =>
    navigate(from === null ? path : `${path}?since=${from}`, { replace: true });
  const earlier = view.rounds.filter((r) => r.n < view.round.n);
  const label = (n: number) =>
    n === view.lastReviewed ? `your last review (round ${n})` : `round ${n}`;
  const tally = since.view
    ? TALLY.map((s) => [since.view!.changes.filter((c) => c.status === s).length, s] as const)
        .filter(([count]) => count > 0)
        .map(([count, s]) => `${count} ${s}`)
        .join(", ") || "no changes"
    : null;

  return (
    <div className="since-bar">
      <fieldset className="segmented" aria-label="What to show">
        <button
          type="button"
          className={since.on ? undefined : "chosen"}
          aria-pressed={!since.on}
          onClick={() => go(null)}
        >
          Whole round
        </button>
        <button
          type="button"
          className={since.on ? "chosen" : undefined}
          aria-pressed={since.on}
          onClick={() => go(since.from)}
        >
          Since {label(since.from)}
        </button>
      </fieldset>
      {since.on && earlier.length > 1 && (
        <select
          value={since.from}
          onChange={(e) => go(Number(e.target.value))}
          aria-label="Compare with round"
        >
          {earlier.map((r) => (
            <option key={r.n} value={r.n}>
              {label(r.n)}
            </option>
          ))}
        </select>
      )}
      {since.error ? (
        <span className="form-error">{since.error.message}</span>
      ) : (
        <span className="muted">
          {tally ?? "Comparing…"}
          {since.view?.baseMoved && " · rebased, and what landed on the base isn't shown"}
        </span>
      )}
    </div>
  );
}
