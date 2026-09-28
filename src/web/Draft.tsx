import { useState } from "react";
import type { DraftComment } from "../ui/api.ts";
import { CommentForm } from "./CommentForm.tsx";
import { useReview } from "./review.tsx";
import { Pill } from "./ui.tsx";

/** A comment in the actor's draft review: only they see it, until the review is submitted. */
export function DraftCard({
  draft,
  suggestFrom = null,
}: {
  draft: DraftComment;
  /** Its lines' text, when it's on lines of the new code the diff shows. */
  suggestFrom?: string | null;
}) {
  const review = useReview();
  const [editing, setEditing] = useState(false);
  const c = draft.comment;

  if (editing) {
    return (
      <div className="thread draft">
        <CommentForm
          initial={{
            body: c.body,
            severity: c.severity ?? null,
            suggestion: c.suggestion ?? null,
          }}
          suggestFrom={suggestFrom ?? c.suggestion ?? null}
          submitLabel="Save"
          onSubmit={async (v) => {
            await review.update(draft.id, { ...c, ...v });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }
  return (
    <article className="thread draft">
      <header className="thread-head">
        <Pill kind="draft">draft</Pill>
        {c.severity && <Pill kind={c.severity}>{c.severity}</Pill>}
        <span className="spacer" />
        {review.canReview && (
          <>
            <button type="button" className="link-button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="link-button danger"
              onClick={() => void review.remove(draft.id)}
            >
              Delete
            </button>
          </>
        )}
      </header>
      <div className="entry">
        <div className="body">{c.body}</div>
        {c.suggestion != null && (
          <figure className="suggestion">
            <figcaption>Suggested change</figcaption>
            <pre>{c.suggestion}</pre>
          </figure>
        )}
      </div>
    </article>
  );
}

export function DraftList({ drafts }: { drafts: DraftComment[] }) {
  if (drafts.length === 0) return null;
  return (
    <div className="thread-list">
      {drafts.map((d) => (
        <DraftCard key={d.id} draft={d} />
      ))}
    </div>
  );
}

/** A button that opens a comment form, for comments on the feature, a change, or a message. */
export function AddComment({
  label,
  target,
}: {
  label: string;
  target: { change?: string; message?: boolean };
}) {
  const review = useReview();
  const [open, setOpen] = useState(false);
  if (!review.canReview) return null;
  if (!open) {
    return (
      <button type="button" className="add-comment" onClick={() => setOpen(true)}>
        + {label}
      </button>
    );
  }
  return (
    <div className="thread draft">
      <CommentForm
        submitLabel="Add to review"
        onSubmit={async (v) => {
          await review.add({ ...target, body: v.body, severity: v.severity });
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
