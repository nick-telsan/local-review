import { type KeyboardEvent, useEffect, useState } from "react";
import type { Severity } from "../model.ts";
import { ApiError } from "./api.ts";

export interface CommentValues {
  body: string;
  severity: Severity | null;
  suggestion: string | null;
}

const SEVERITIES: (Severity | null)[] = [null, "blocking", "suggestion", "nit", "question"];

/**
 * Write a comment: its text, a severity, and (on lines of the new code) a suggested replacement.
 * ⌘/Ctrl-Enter submits, Escape cancels.
 */
export function CommentForm({
  initial,
  suggestFrom = null,
  heading,
  submitLabel,
  onSubmit,
  onChange,
  onCancel,
}: {
  initial?: CommentValues;
  /** What it's on, e.g. "Lines 3–4". */
  heading?: string;
  /** The selected lines' text, which a suggestion starts from; null when suggestions don't apply. */
  suggestFrom?: string | null;
  submitLabel: string;
  onSubmit: (values: CommentValues) => Promise<void>;
  /** Hears each edit, so what's written can outlive the form. */
  onChange?: (values: CommentValues) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial?.body ?? "");
  const [severity, setSeverity] = useState<Severity | null>(initial?.severity ?? null);
  const [suggestion, setSuggestion] = useState<string | null>(initial?.suggestion ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    onChange?.({ body, severity, suggestion });
  }, [body, severity, suggestion, onChange]);

  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ body, severity, suggestion });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <form
      className="comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {heading && <p className="form-heading muted">{heading}</p>}
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens because the reviewer asked to write
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Leave a comment"
        rows={3}
        aria-label="Comment"
      />
      {suggestion !== null && (
        <label className="suggestion-edit">
          <span>Suggested change</span>
          <textarea
            value={suggestion}
            onChange={(e) => setSuggestion(e.target.value)}
            onKeyDown={onKeyDown}
            rows={Math.max(2, suggestion.split("\n").length)}
            spellCheck={false}
          />
        </label>
      )}
      <div className="form-row">
        <fieldset className="severity-picker">
          <legend className="sr-only">Severity</legend>
          {SEVERITIES.map((s) => (
            <label key={s ?? "none"} className={severity === s ? "chosen" : undefined}>
              <input
                type="radio"
                name="severity"
                checked={severity === s}
                onChange={() => setSeverity(s)}
              />
              {s ?? "no severity"}
            </label>
          ))}
        </fieldset>
        {suggestFrom !== null && (
          <button
            type="button"
            className="link-button"
            onClick={() => setSuggestion(suggestion === null ? suggestFrom : null)}
          >
            {suggestion === null ? "Suggest a change" : "Remove suggestion"}
          </button>
        )}
        <span className="spacer" />
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!body.trim() || busy}>
          {submitLabel}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
