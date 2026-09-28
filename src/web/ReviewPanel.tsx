import { useState } from "react";
import type { Verdict } from "../model.ts";
import { ApiError, send } from "./api.ts";
import { useReview } from "./review.tsx";

const VERDICTS: { value: Verdict | null; label: string; hint: string }[] = [
  { value: null, label: "Comment", hint: "Comments only, no verdict" },
  { value: "changes_requested", label: "Request changes", hint: "The author revises" },
  { value: "approved", label: "Approve", hint: "Ready to finalize" },
];

/** Finish the review: a verdict and summary, then submit the draft's comments with them. */
export function ReviewPanel() {
  const review = useReview();
  const { view } = review;
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  if (!review.canReview) return null;

  const count = review.drafts.length;
  const show = () => {
    setVerdict(view.draft?.verdict ?? null);
    setBody(view.draft?.body ?? "");
    setError(null);
    setDiscarding(false);
    setOpen(true);
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // The summary is kept with the draft, so closing the panel or the page doesn't lose it.
  const save = (next: { verdict: Verdict | null; body: string }) =>
    send("PUT", `${review.path}/draft`, next).catch(() => {});

  return (
    <div className="review-panel-anchor">
      <button type="button" className="primary" onClick={() => (open ? setOpen(false) : show())}>
        Finish review{count > 0 && <span className="count on-primary">{count}</span>}
      </button>
      {open && (
        <div className="review-panel" role="dialog" aria-label="Finish your review">
          <h3>Review round {view.round.n}</h3>
          <p className="muted">
            {count === 0
              ? "No comments drafted."
              : `${count} drafted comment${count === 1 ? "" : "s"} will be submitted with it.`}
          </p>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => void save({ verdict, body })}
            placeholder="Summary (optional)"
            rows={4}
            aria-label="Summary"
          />
          <fieldset className="verdicts">
            <legend className="sr-only">Verdict</legend>
            {VERDICTS.map((v) => (
              <label key={v.label} className={verdict === v.value ? "chosen" : undefined}>
                <input
                  type="radio"
                  name="verdict"
                  checked={verdict === v.value}
                  onChange={() => {
                    setVerdict(v.value);
                    void save({ verdict: v.value, body });
                  }}
                />
                <span>
                  <strong>{v.label}</strong>
                  <span className="muted"> · {v.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && <p className="form-error">{error}</p>}
          <div className="form-row">
            {count > 0 || view.draft ? (
              discarding ? (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void run(() => send("DELETE", `${review.path}/draft`))}
                >
                  Discard {count} comment{count === 1 ? "" : "s"}?
                </button>
              ) : (
                <button type="button" className="link-button" onClick={() => setDiscarding(true)}>
                  Discard draft
                </button>
              )
            ) : null}
            <span className="spacer" />
            <button type="button" onClick={() => setOpen(false)}>
              Close
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(() => send("POST", `${review.path}/draft/submit`, { verdict, body }))
              }
            >
              Submit review
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
