import { AnchorResolver, describeAnchor } from "../anchors.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import type { Thread } from "../model.ts";
import { takeSnapshot } from "../snapshot.ts";

const USAGE = 'usage: lr note <change> [<path>:<line>[-<line>] [--old]] "<text>"';

/** `src/db.ts:40` or `src/db.ts:40-42`. */
const LOCATION = /^(\S+):(\d+)(?:-(\d+))?$/;

/** `lr note --json` output. */
export interface NoteOk {
  thread: Thread;
}

/**
 * Leave a note on your own change for its reviewers, instead of a comment in the code: on the
 * change, or on lines of the diff it introduces. Notes are written against the stack as it is
 * now, before a round has it, so they work while a phase is still being written.
 */
export async function note(
  ctx: Context,
  args: string[],
  opts: { message?: string; old?: boolean },
): Promise<number> {
  const [change, ...rest] = args;
  if (!change) throw new LrError(USAGE);
  const location = rest[0] !== undefined ? LOCATION.exec(rest[0]) : null;
  if (location) rest.shift();
  if (opts.old && !location) throw new LrError(`--old needs a location\n${USAGE}`);
  if (rest.length > 1 || (rest.length === 1 && opts.message !== undefined)) {
    throw new LrError(`give the note's text as one quoted argument, or with -m\n${USAGE}`);
  }
  const body = (opts.message ?? rest[0] ?? "").trim();
  if (!body) throw new LrError(`a note needs text\n${USAGE}`);

  let lines: [number, number] | null = null;
  if (location) {
    const first = Number(location[2]);
    const last = Number(location[3] ?? first);
    if (first < 1 || last < first) {
      throw new LrError(`lines must be 1-based, first ≤ last: ${location[0]}`);
    }
    lines = [first, last];
  }

  const feature = ctx.feature();
  if (feature.status === "done" || feature.status === "abandoned") {
    throw new LrError(`feature "${feature.slug}" is ${feature.status}`);
  }
  const plan = ctx.currentPlan(feature);
  const snap = await takeSnapshot(ctx.jj, feature.baseRevset, plan.phases, {
    beforeBookmarks: true,
  });
  const anchor = await new AnchorResolver(ctx.jj, snap, plan.phases).resolve({
    change,
    phase: null,
    path: location ? location[1]! : null,
    lines,
    side: opts.old ? "old" : "new",
    message: false,
    final: null,
    prBody: false,
    severity: null,
    body,
    suggestion: null,
  });

  const thread = ctx.store.addNote(feature.slug, {
    anchor,
    anchorStack: {
      baseCommitId: snap.baseCommitId,
      changes: snap.changes.map((c) => ({ changeId: c.changeId, commitId: c.commitId })),
    },
    author: ctx.actor,
    body,
    round: ctx.store.latestRound(feature.slug)?.n ?? null,
  });
  const json: NoteOk = { thread };
  ctx.print(json, `Noted #${thread.id} on ${describeAnchor(anchor)}`);
  return 0;
}
