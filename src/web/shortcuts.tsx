// Keyboard shortcuts on a round's pages. They act on what's rendered (the sidebar's links, the
// threads, the diff's files), so each page opts in by what it shows, not by wiring.
import { useEffect, useRef, useState } from "react";

const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ["j", "k"], what: "Next / previous page in the stack: overview, plan, each change" },
  { keys: ["n", "p"], what: "Next / previous unresolved thread, on to the next page with one" },
  { keys: ["r"], what: "Reply to the selected thread (Tab reaches its other buttons)" },
  { keys: ["]", "["], what: "Next / previous file in the diff" },
  { keys: ["c"], what: "Comment on this change, the plan, or (on the overview) the feature" },
  { keys: ["s"], what: "Switch between the whole round and what changed since your last review" },
  { keys: ["f"], what: "Finish your review" },
  { keys: ["?"], what: "Show these shortcuts" },
];

/** What `n` and `p` stop at: threads that still need someone, as the sidebar counts them. */
const UNSETTLED = "article.thread:is(.thread-proposed, .thread-open, .thread-addressed)";
/** Below the sticky top bar and file header. */
const TOP = 100;

/** Listen for the shortcuts, and show their list on `?`. */
export function Shortcuts() {
  const [help, setHelp] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current!;
    if (help && !d.open) d.showModal();
    if (!help && d.open) d.close();
  }, [help]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const say = (text: string) => {
      setFlash(text);
      clearTimeout(timer);
      timer = setTimeout(() => setFlash(null), 2000);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typing(e.target)) return;
      // While the list is open (Esc closes it), the page behind it doesn't take keys.
      if (dialog.current?.open && e.key !== "?") return;
      const action = ACTIONS[e.key];
      if (!action) return;
      e.preventDefault();
      if (e.key === "?") setHelp((h) => !h);
      else action(say);
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <button
        type="button"
        className="shortcuts-button"
        onClick={() => setHelp((h) => !h)}
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
      >
        ?
      </button>
      {flash && (
        <div className="flash" role="status">
          {flash}
        </div>
      )}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc and the Close button do this by keyboard */}
      <dialog
        ref={dialog}
        className="shortcuts"
        aria-label="Keyboard shortcuts"
        onClose={() => setHelp(false)}
        // A click on the backdrop lands on the dialog itself; its content is in the div.
        onClick={(e) => e.target === e.currentTarget && setHelp(false)}
      >
        <div className="shortcuts-body">
          <h3>Keyboard shortcuts</h3>
          <dl>
            {SHORTCUTS.map((s) => (
              <div key={s.what}>
                <dt>
                  {s.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </dt>
                <dd>{s.what}</dd>
              </div>
            ))}
          </dl>
          <p className="muted">
            In a comment: <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>Enter</kbd> saves it, <kbd>Esc</kbd>{" "}
            cancels. Shift-click a line number to comment on a range.
          </p>
          <div className="form-row">
            <span className="spacer" />
            <button type="button" onClick={() => setHelp(false)}>
              Close
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

type Say = (text: string) => void;

const ACTIONS: Record<string, (say: Say) => void> = {
  j: () => step(1),
  k: () => step(-1),
  n: (say) => thread(1, say),
  p: (say) => thread(-1, say),
  r: (say) => {
    const t = selectedThread();
    const button = t?.querySelector<HTMLButtonElement>("[data-shortcut=reply]");
    if (button) button.click();
    else say(t ? "This thread takes no replies here" : "Select a thread first (n or p)");
  },
  "]": (say) => file(1, say),
  "[": (say) => file(-1, say),
  c: (say) => {
    const button = main()?.querySelector<HTMLButtonElement>("[data-shortcut=comment]");
    if (button) button.click();
    else say("Nothing to comment on here, or the comment form is already open");
  },
  s: (say) => {
    const other = document.querySelector<HTMLButtonElement>(
      ".since-bar .segmented button:not(.chosen)",
    );
    if (other) other.click();
    else say("Round 1 has nothing earlier to compare with");
  },
  f: () => document.querySelector<HTMLButtonElement>(".review-panel-anchor > button")?.click(),
  "?": () => {},
};

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

const main = () => document.querySelector<HTMLElement>(".round-main");
const sideLinks = () => [...document.querySelectorAll<HTMLAnchorElement>(".sidebar a.side-item")];

/** The sidebar link `by` places from the current one. */
function step(by: number): void {
  const links = sideLinks();
  const i = links.findIndex((a) => a.classList.contains("current"));
  links[i + by]?.click();
}

function selectedThread(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>("article.thread")
    : null;
}

function select(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "center" });
}

/**
 * The next (or previous) unresolved thread after the selected one, or after what's in view. Past
 * the last one on the page, go on to the next page in the sidebar that counts one.
 */
function thread(by: 1 | -1, say: Say): void {
  const threads = [...(main()?.querySelectorAll<HTMLElement>(UNSETTLED) ?? [])];
  const current = selectedThread();
  const i = current ? threads.indexOf(current) : -1;
  const target =
    i >= 0
      ? threads[i + by]
      : by === 1
        ? threads.find((t) => t.getBoundingClientRect().top > TOP)
        : threads.findLast((t) => t.getBoundingClientRect().bottom < innerHeight);
  if (target) {
    select(target);
    return;
  }

  onward(by, say, current?.id ?? null);
}

/**
 * Go to the next (or previous) page in the sidebar that counts unresolved threads, and select its
 * first (or last). Skip `left`, the thread just left: a phase's threads show on the overview too.
 */
function onward(by: 1 | -1, say: Say, left: string | null): void {
  const links = sideLinks();
  const here = links.findIndex((a) => a.classList.contains("current"));
  const ahead = by === 1 ? links.slice(here + 1) : links.slice(0, Math.max(here, 0)).reverse();
  const next = ahead.find((a) => a.querySelector(".count"));
  if (!next) {
    say(`No ${by === 1 ? "more" : "earlier"} unresolved threads`);
    return;
  }
  next.click();
  void arrive(next.getAttribute("href")!).then((ts) => {
    const fresh = ts.filter((t) => t.id !== left);
    const t = by === 1 ? fresh[0] : fresh.at(-1);
    if (t) select(t);
    else if (ts.length) onward(by, say, left);
    else say("Its unresolved threads aren't shown here");
  });
}

/** The unresolved threads on page `href`, once it (and its diff) has loaded; empty after 3s. */
async function arrive(href: string): Promise<HTMLElement[]> {
  for (let waited = 0; waited < 3000; waited += 50) {
    await new Promise((r) => setTimeout(r, 50));
    if (location.pathname + location.search !== href) continue;
    const m = main();
    if (!m || m.querySelector(".loading")) continue;
    const found = [...m.querySelectorAll<HTMLElement>(UNSETTLED)];
    if (found.length) return found;
  }
  return [];
}

/** Scroll to the next (or previous) file of the diff, from the one at the top. */
function file(by: 1 | -1, say: Say): void {
  const files = [...(main()?.querySelectorAll<HTMLElement>("section.file") ?? [])];
  if (!files.length) {
    say("No files on this page");
    return;
  }
  // The file at the top of the view: the last one starting at or above it. Partway into it,
  // "previous" means back to its start.
  const top = files.findLastIndex((f) => f.getBoundingClientRect().top <= TOP);
  const partway = top >= 0 && files[top]!.getBoundingClientRect().top < TOP - 60;
  const target = by === 1 ? files[top + 1] : partway ? files[top] : files[top - 1];
  if (target) target.scrollIntoView({ block: "start" });
  else say(by === 1 ? "That's the last file" : "That's the first file");
}
