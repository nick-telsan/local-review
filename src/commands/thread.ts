import { formatActor } from "../actor.ts";
import { describeAnchor } from "../anchors.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import type { Entry, Thread, ThreadStatus } from "../model.ts";

export type ReplyAction = "addressed" | "resolve" | "dismiss" | "reopen" | "accept";

/**
 * Who may move a thread where. The author marks threads addressed; reviewers (a human, or the
 * agent that raised the thread) resolve, dismiss, and reopen; only humans accept proposed
 * (untriaged) agent comments.
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
    const raisedIt = formatActor(ctx.actor) === formatActor(thread.createdBy);
    if (rule.who === "human" && !isHuman) {
      throw new LrError(`only a human can --${opts.action} a thread`);
    }
    if (rule.who === "reviewer" && !isHuman && !raisedIt) {
      throw new LrError(
        `only a human or the thread's reviewer (${formatActor(thread.createdBy)}) can --${opts.action} it`,
      );
    }
    statusChange = { from: thread.status, to: rule.to };
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

const STATUSES: ThreadStatus[] = ["proposed", "open", "addressed", "resolved", "dismissed"];
const UNSETTLED: ThreadStatus[] = ["proposed", "open", "addressed"];

/** `lr threads --json` output. */
export interface ThreadsOk {
  threads: Thread[];
}

/** List threads: unsettled ones by default, or `--status a,b`, or `--all`. */
export async function threads(
  ctx: Context,
  opts: { status?: string; all?: boolean },
): Promise<number> {
  let wanted = UNSETTLED;
  if (opts.all) wanted = STATUSES;
  else if (opts.status) {
    wanted = opts.status.split(",").map((s) => s.trim()) as ThreadStatus[];
    const bad = wanted.filter((s) => !STATUSES.includes(s));
    if (bad.length) {
      throw new LrError(`unknown status ${bad.join(", ")} (expected ${STATUSES.join(", ")})`);
    }
  }
  const feature = ctx.feature();
  const found = ctx.store.listThreads(feature.slug).filter((t) => wanted.includes(t.status));

  const json: ThreadsOk = { threads: found };
  ctx.print(
    json,
    found.length === 0
      ? `No ${wanted.join("/")} threads.`
      : found.map((t) => {
          const first = t.entries[0]!.body.split("\n")[0]!;
          const replies = t.entries.length - 1;
          return (
            `#${String(t.id).padEnd(4)} ${t.status.padEnd(10)} ${(t.severity ?? "").padEnd(10)} ` +
            `${describeAnchor(t.anchor)}  ${truncate(first, 60)}` +
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
