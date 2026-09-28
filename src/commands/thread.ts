import { formatActor } from "../actor.ts";
import { describeAnchor } from "../anchors.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import type { Actor, Entry, Thread, ThreadStatus } from "../model.ts";

export type ReplyAction = "addressed" | "resolve" | "dismiss" | "reopen" | "accept";

/**
 * Who may move a thread where. The author marks threads addressed; reviewers (a human, or the
 * agent that raised the thread) resolve, dismiss, and reopen; only humans accept proposed
 * (untriaged) agent comments. A note's reviewer is whoever reopened it.
 */
const ACTIONS: Record<
  ReplyAction,
  { from: ThreadStatus[]; to: ThreadStatus; who: "anyone" | "reviewer" | "human" }
> = {
  addressed: { from: ["open"], to: "addressed", who: "anyone" },
  resolve: { from: ["open", "addressed"], to: "resolved", who: "reviewer" },
  dismiss: { from: ["proposed", "open", "addressed"], to: "dismissed", who: "reviewer" },
  reopen: { from: ["addressed", "resolved", "dismissed"], to: "open", who: "reviewer" },
  accept: { from: ["proposed"], to: "open", who: "human" },
};

/** `lr reply --json` output. */
export interface ReplyOk {
  thread: Thread;
}

export async function reply(
  ctx: Context,
  idArg: string | undefined,
  opts: { action: ReplyAction | null; body: string | null },
): Promise<number> {
  const id = /^#?(\d+)$/.exec(idArg ?? "")?.[1];
  if (!id) {
    throw new LrError(
      "usage: lr reply <thread> [--addressed|--resolve|--dismiss|--reopen|--accept] [<message>]",
    );
  }
  const feature = ctx.feature();
  const thread = ctx.store.getThread(feature.slug, Number(id));
  if (!thread) throw new LrError(`no thread #${id} in ${feature.slug}`);

  let statusChange: Entry["statusChange"] = null;
  if (opts.action) {
    const rule = ACTIONS[opts.action];
    if (!rule.from.includes(thread.status)) {
      throw new LrError(
        `#${id} is ${thread.status}; --${opts.action} applies to ${orList(rule.from)} threads`,
      );
    }
    const isHuman = ctx.actor.kind === "human";
    if (rule.who === "human" && !isHuman) {
      throw new LrError(`only a human can --${opts.action} a thread`);
    }
    if (rule.who === "reviewer" && !isHuman && !isReviewer(ctx.actor, thread)) {
      const reviewer = reviewerOf(thread);
      throw new LrError(
        reviewer
          ? `only a human or the thread's reviewer (${formatActor(reviewer)}) can --${opts.action} it`
          : `only a human or someone other than the note's author can --${opts.action} it`,
      );
    }
    statusChange = { from: thread.status, to: rule.to };
  } else if (
    thread.kind === "note" &&
    thread.status === "resolved" &&
    !same(ctx.actor, thread.createdBy)
  ) {
    // Someone else replying to a note is asking about it, so it goes back to its author.
    statusChange = { from: "resolved", to: "open" };
  }

  // Replies and "addressed" need words; resolving, dismissing, etc. can stand alone.
  const body = opts.body?.trim() ?? "";
  if (!body && (!opts.action || opts.action === "addressed")) {
    throw new LrError(
      opts.action ? `--addressed needs a message saying what changed` : "a reply needs a message",
    );
  }

  const updated = ctx.store.addEntry(feature.slug, thread.id, {
    id: Bun.randomUUIDv7(),
    author: ctx.actor,
    body,
    suggestion: null,
    statusChange,
    round: ctx.store.latestRound(feature.slug)?.n ?? null,
    createdAt: new Date().toISOString(),
  });
  const json: ReplyOk = { thread: updated };
  ctx.print(
    json,
    statusChange
      ? `#${id}: ${statusChange.from} → ${statusChange.to}`
      : `Replied to #${id} (${updated.status})`,
  );
  return 0;
}

const same = (a: Actor, b: Actor) => formatActor(a) === formatActor(b);

/** Who reviews a thread: whoever raised a comment, or whoever last reopened a note. */
function reviewerOf(t: Thread): Actor | null {
  if (t.kind === "comment") return t.createdBy;
  return t.entries.findLast((e) => e.statusChange?.to === "open")?.author ?? null;
}

/** A note nobody has reopened can be reviewed by anyone but its author. */
function isReviewer(actor: Actor, t: Thread): boolean {
  const reviewer = reviewerOf(t);
  return reviewer ? same(actor, reviewer) : !same(actor, t.createdBy);
}

const STATUSES: ThreadStatus[] = ["proposed", "open", "addressed", "resolved", "dismissed"];
const UNSETTLED: ThreadStatus[] = ["proposed", "open", "addressed"];

/** `lr threads --json` output. */
export interface ThreadsOk {
  threads: Thread[];
}

/**
 * List threads: unsettled ones by default, or `--status a,b`, or `--all`. `--notes` lists the
 * author's notes (in any status unless `--status` says otherwise).
 */
export async function threads(
  ctx: Context,
  opts: { status?: string; all?: boolean; notes?: boolean },
): Promise<number> {
  let wanted = UNSETTLED;
  if (opts.all || (opts.notes && !opts.status)) wanted = STATUSES;
  else if (opts.status) {
    wanted = opts.status.split(",").map((s) => s.trim()) as ThreadStatus[];
    const bad = wanted.filter((s) => !STATUSES.includes(s));
    if (bad.length) {
      throw new LrError(`unknown status ${bad.join(", ")} (expected ${STATUSES.join(", ")})`);
    }
  }
  const feature = ctx.feature();
  const found = ctx.store
    .listThreads(feature.slug)
    .filter((t) => wanted.includes(t.status) && (!opts.notes || t.kind === "note"));

  const json: ThreadsOk = { threads: found };
  ctx.print(
    json,
    found.length === 0
      ? `No ${wanted.join("/")} ${opts.notes ? "notes" : "threads"}.`
      : found.map((t) => {
          const first = t.entries[0]!.body.split("\n")[0]!;
          const replies = t.entries.length - 1;
          return (
            `#${String(t.id).padEnd(4)} ${t.status.padEnd(10)} ` +
            `${(t.kind === "note" ? "note" : (t.severity ?? "")).padEnd(10)} ` +
            `${describeAnchor(t.anchor)}${t.anchorState === "outdated" ? " (outdated)" : ""}  ` +
            truncate(first, 60) +
            (replies ? `  (+${replies} ${replies === 1 ? "reply" : "replies"})` : "")
          );
        }),
  );
  return 0;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `a`, `a or b`, `a, b, or c`. */
function orList(items: string[]): string {
  if (items.length <= 2) return items.join(" or ");
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}
