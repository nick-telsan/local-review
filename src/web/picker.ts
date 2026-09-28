// Picking lines to comment on: click a line number, drag across several, or shift-click to extend.
import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { CommentValues } from "./CommentForm.tsx";

export interface Picked<S extends string> {
  side: S;
  lines: [number, number];
}

/**
 * The lines picked for a new comment, and what's written in its form so far. The form moves to
 * the last picked line as the pick changes, so it remounts; what's written carries over.
 */
export function useLinePicker<S extends string>() {
  // `anchor` is where the pick started, `head` where it is now.
  const [selection, setSelection] = useState<{ side: S; anchor: number; head: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const written = useRef<{ values: CommentValues; prefill: string | null } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    addEventListener("mouseup", stop);
    return () => removeEventListener("mouseup", stop);
  }, [dragging]);

  const picked: Picked<S> | null = selection && {
    side: selection.side,
    lines: [Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)],
  };
  const pick = (side: S, n: number, extend: boolean) =>
    setSelection(
      extend && selection?.side === side ? { ...selection, head: n } : { side, anchor: n, head: n },
    );

  return {
    picked,
    /** Where the form goes: the pick, once the pointer is up. */
    open: dragging ? null : picked,
    isPicked: (side: S, n: number | null) =>
      picked !== null &&
      n !== null &&
      picked.side === side &&
      n >= picked.lines[0] &&
      n <= picked.lines[1],
    /** Props for a line number's button. */
    button: (side: S, n: number) => ({
      title: "Comment on this line (drag or shift-click for several)",
      onMouseDown: (e: MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection while dragging, and the form keeps focus
        pick(side, n, e.shiftKey);
        setDragging(true);
      },
      onMouseEnter: () => {
        if (dragging && selection?.side === side) setSelection({ ...selection, head: n });
      },
      // Keyboard activation (a mouse click was handled on mousedown).
      onClick: (e: MouseEvent) => {
        if (e.detail === 0) pick(side, n, e.shiftKey);
      },
    }),
    /**
     * Props for the form, given the picked lines' text a suggestion starts from. A suggestion
     * that wasn't edited follows the pick; an edited one is kept.
     */
    form: (prefill: string | null) => {
      const w = written.current;
      const suggestion =
        w && w.values.suggestion !== null && w.values.suggestion === w.prefill
          ? prefill
          : (w?.values.suggestion ?? null);
      const [a, b] = picked!.lines;
      return {
        initial: w ? { ...w.values, suggestion } : undefined,
        suggestFrom: prefill,
        heading: `${a === b ? `Line ${a}` : `Lines ${a}–${b}`}${
          picked!.side === "old" ? " (old side)" : ""
        } · shift-click a line number to extend`,
        onChange: (values: CommentValues) => {
          written.current = { values, prefill };
        },
      };
    },
    /** Forget the pick and what was written (after adding the comment, or cancelling). */
    clear: () => {
      written.current = null;
      setSelection(null);
    },
  };
}
