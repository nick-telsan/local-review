import { join } from "node:path";
import { findChange } from "../anchors.ts";
import { loadRepoConfig } from "../config.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import {
  approvedRound,
  checkMessage,
  Drafts,
  type SquashGroup,
  squashGroups,
  stackCommits,
} from "../final.ts";
import type { Feature, FinalSnapshot, Phase, Round } from "../model.ts";
import { reanchorThreads } from "../reanchor.ts";
import { codeChanges, type Snapshot, takeSnapshot } from "../snapshot.ts";
import {
  type CheckResultJson,
  checkJson,
  checkStack,
  describeReanchored,
  printBlocked,
  type ReviewCreateOk,
} from "./review.ts";

/** Where finalization stands: the approved code round and how it groups into final commits. */
interface FinalState {
  feature: Feature;
  round: Round;
  phases: Phase[];
  groups: SquashGroup[];
  drafts: Drafts;
}

function loadFinal(ctx: Context): FinalState {
  const feature = ctx.feature();
  const round = approvedRound(ctx.store.latestRound(feature.slug, "code"), feature);
  const phases = ctx.store.getPlanVersion(feature.slug, round.planVersion)!.phases;
  const groups = squashGroups(round.changes, phases, ctx.store.listCuts(feature.slug));
  const drafts = new Drafts(join(ctx.featureDir(feature.slug), "final"));
  return { feature, round, phases, groups, drafts };
}

const subject = (text: string) => text.split("\n")[0]!;
const short = (id: string) => id.slice(0, 8);

// ── lr final show ─────────────────────────────────────────────────────────────

/** `lr final show --json` output. */
export interface FinalShowOk {
  /** The approved code round the final commits are built from. */
  round: number;
  groups: {
    id: string;
    phaseId: number;
    phaseTitle: string;
    bookmark: string;
    changes: { changeId: string; commitId: string; description: string }[];
    message: string | null;
    messagePath: string;
  }[];
  prBody: string | null;
  prBodyPath: string;
  /** From `[final]` in `.local-review.toml`, for whoever drafts the texts. */
  commitGuidelines: { path: string; text: string } | null;
  prTemplate: { path: string; text: string } | null;
}

export async function finalShow(ctx: Context): Promise<number> {
  const s = loadFinal(ctx);
  const { final: config } = await loadRepoConfig(ctx.jj.root);
  const guide = async (path: string | null) =>
    path ? { path, text: await Bun.file(join(ctx.jj.root, path)).text() } : null;

  const json: FinalShowOk = {
    round: s.round.n,
    groups: s.groups.map((g) => ({
      id: g.id,
      phaseId: g.phase.id,
      phaseTitle: g.phase.title,
      bookmark: g.phase.bookmark,
      changes: g.changes.map((c) => ({
        changeId: c.changeId,
        commitId: c.commitId,
        description: c.description,
      })),
      message: s.drafts.message(g.id),
      messagePath: s.drafts.messagePath(g.id),
    })),
    prBody: s.drafts.prBody(),
    prBodyPath: s.drafts.prBodyPath,
    commitGuidelines: await guide(config.commitGuidelines),
    prTemplate: await guide(config.prTemplate),
  };

  const lines = [`Final commits for ${s.feature.slug}, from round ${s.round.n}:`];
  for (const g of json.groups) {
    lines.push(`  ${g.id.padEnd(4)} ${g.phaseTitle} (${g.bookmark})`);
    for (const c of g.changes)
      lines.push(`         ${short(c.changeId)}  ${subject(c.description)}`);
    lines.push(
      g.message
        ? `       message: ${subject(g.message)}`
        : `       message: not drafted (lr final message ${g.id} -F <file>)`,
    );
  }
  lines.push(
    json.prBody
      ? `PR body: ${subject(json.prBody)}`
      : "PR body: not drafted (lr final pr-body -F <file>)",
    `Drafts are files you can edit directly: ${join(ctx.featureDir(s.feature.slug), "final")}`,
  );
  if (json.commitGuidelines) lines.push(`Commit guidelines: ${json.commitGuidelines.path}`);
  if (json.prTemplate) lines.push(`PR template: ${json.prTemplate.path}`);
  ctx.print(json, lines);
  return 0;
}

// ── lr final message / pr-body ────────────────────────────────────────────────

/** `lr final message --json` and `lr final pr-body --json` output. */
export interface FinalDraftOk {
  /** The group id, or null for the PR body. */
  group: string | null;
  path: string;
  text: string;
  warnings: string[];
}

export async function finalMessage(
  ctx: Context,
  groupArg: string | undefined,
  file: string | undefined,
): Promise<number> {
  if (!groupArg || !file) throw new LrError("usage: lr final message <group> -F <file>");
  const s = loadFinal(ctx);
  const group = s.groups.find((g) => g.id === groupArg);
  if (!group) {
    throw new LrError(
      `no final commit "${groupArg}" (groups: ${s.groups.map((g) => g.id).join(", ")})`,
    );
  }
  const text = await ctx.readInput(file);
  const warnings = checkMessage(text, `the message for ${group.id}`);
  s.drafts.setMessage(group.id, text);
  return printDraft(ctx, {
    group: group.id,
    path: s.drafts.messagePath(group.id),
    text: s.drafts.message(group.id)!,
    warnings,
  });
}

export async function finalPrBody(ctx: Context, file: string | undefined): Promise<number> {
  if (!file) throw new LrError("usage: lr final pr-body -F <file>");
  const s = loadFinal(ctx);
  const text = await ctx.readInput(file);
  if (!text.trim()) throw new LrError("the PR body is empty");
  s.drafts.setPrBody(text);
  return printDraft(ctx, {
    group: null,
    path: s.drafts.prBodyPath,
    text: s.drafts.prBody()!,
    warnings: [],
  });
}

function printDraft(ctx: Context, json: FinalDraftOk): number {
  const what = json.group === null ? "the PR body" : `the message for final commit ${json.group}`;
  ctx.print(json, [`Saved ${what} (${json.path})`, ...json.warnings.map((w) => `warning: ${w}`)]);
  return 0;
}

// ── lr final cut ──────────────────────────────────────────────────────────────

/** `lr final cut --json` output: the phase's final commits after the change. */
export interface FinalCutOk {
  phaseId: number;
  groups: { id: string; changeIds: string[] }[];
  /** Drafted messages that were dropped because their group ids changed. */
  cleared: string[];
}

/** Start a new final commit at a change (or, with `--remove`, stop doing so). */
export async function finalCut(
  ctx: Context,
  changeArg: string | undefined,
  remove: boolean,
): Promise<number> {
  if (!changeArg) throw new LrError("usage: lr final cut <change> [--remove]");
  const s = loadFinal(ctx);
  const change = findChange(s.round, changeArg);
  const phase = s.phases.find((p) => p.id === change.phaseId)!;
  const cuts = ctx.store.listCuts(s.feature.slug);
  const isCut = cuts.includes(change.changeId);
  if (s.round.changes.find((c) => c.phaseId === phase.id) === change) {
    throw new LrError(
      `${short(change.changeId)} is the first change of phase ${phase.id}, so a cut there changes nothing`,
    );
  }
  if (remove && !isCut) throw new LrError(`there's no cut at ${short(change.changeId)}`);
  if (!remove && isCut) throw new LrError(`there's already a cut at ${short(change.changeId)}`);

  ctx.store.setCut(s.feature.slug, change.changeId, !remove);
  const before = s.groups.filter((g) => g.phase.id === phase.id);
  const after = squashGroups(s.round.changes, s.phases, ctx.store.listCuts(s.feature.slug)).filter(
    (g) => g.phase.id === phase.id,
  );
  // Group ids in this phase change (2 → 2a, 2b), so their drafts no longer match.
  const ids = new Set([...before, ...after].map((g) => g.id));
  const cleared = [...ids].filter((id) => s.drafts.clearMessage(id));

  const json: FinalCutOk = {
    phaseId: phase.id,
    groups: after.map((g) => ({ id: g.id, changeIds: g.changes.map((c) => c.changeId) })),
    cleared,
  };
  ctx.print(json, [
    `Phase ${phase.id} is now ${after.length} final commit${after.length === 1 ? "" : "s"}: ` +
      after
        .map((g) => `${g.id} (${g.changes.length} change${g.changes.length === 1 ? "" : "s"})`)
        .join(", "),
    ...(cleared.length
      ? [`Cleared drafted messages for ${cleared.join(", ")}; draft them again.`]
      : []),
  ]);
  return 0;
}

// ── lr review create --final ──────────────────────────────────────────────────

/**
 * Open a final round: freeze the squash groups, their messages, and the PR body for review. The
 * stack must have the code a human approved (a clean rebase is fine), with every draft written
 * and no thread open.
 */
export async function finalRoundCreate(ctx: Context): Promise<number> {
  const s = loadFinal(ctx);
  const slug = s.feature.slug;
  const snap = await takeSnapshot(ctx.jj, s.feature.baseRevset, s.phases);
  const changed = await codeChanges(ctx.jj, s.round.changes, snap.changes);
  if (changed.length) {
    throw new LrError(
      `the code changed since round ${s.round.n} was approved (${changed.join("; ")}); open a ` +
        "code round with `lr review create`",
    );
  }
  const threads = ctx.store.listThreads(slug);
  const unsettled = threads.filter((t) => t.status === "open" || t.status === "proposed");
  if (unsettled.length) {
    throw new LrError(
      `settle these threads first: ${unsettled.map((t) => `#${t.id} (${t.status})`).join(", ")} (see \`lr handoff\`)`,
    );
  }
  const prBody = s.drafts.prBody();
  const missing = s.groups.filter((g) => !s.drafts.message(g.id)).map((g) => `message ${g.id}`);
  if (!prBody) missing.push("the PR body");
  if (missing.length) {
    throw new LrError(`draft these first: ${missing.join(", ")} (see \`lr final show\`)`);
  }

  const final: FinalSnapshot = {
    approvedRound: s.round.n,
    groups: s.groups.map((g) => ({
      id: g.id,
      phaseId: g.phase.id,
      changeIds: g.changes.map((c) => c.changeId),
      message: s.drafts.message(g.id)!,
    })),
    prBody: prBody!,
  };
  const warnings: string[] = [];
  let checks: CheckResultJson[] = ctx.store
    .roundChecks(slug, s.round.n)
    .map((c) => ({ ...c, cached: true }));
  if (rewritten(snap, s.round)) {
    const results = await checkStack(ctx, slug, snap.changes, s.phases);
    if (results.some((r) => r.run.status !== "pass")) {
      return printBlocked(ctx, {
        heading:
          "No final round opened: checks fail on the rebased stack. Fix them and open a code " +
          "round with `lr review create`.",
        conflicted: [],
        results,
        warnings: snap.warnings,
      });
    }
    checks = results.map(checkJson);
    warnings.push(
      `the stack was rebased since round ${s.round.n} was approved; the code is the same, and ` +
        "the checks ran on the new commits",
    );
  }
  const { round, replaced } = ctx.store.createRound(slug, {
    jjOpId: snap.jjOpId,
    planVersion: s.round.planVersion,
    baseCommitId: snap.baseCommitId,
    changes: snap.changes,
    checkRunIds: checks.map((c) => c.id),
    createdBy: ctx.actor,
    final,
  });
  const reanchored = await reanchorThreads({
    jj: ctx.jj,
    store: ctx.store,
    slug,
    round,
    phases: s.phases,
  });

  const addressed = threads.filter((t) => t.status === "addressed").map((t) => `#${t.id}`);
  if (addressed.length) {
    warnings.push(`${addressed.join(", ")} marked addressed, still waiting on their reviewers`);
  }
  const json: ReviewCreateOk = {
    ok: true,
    round,
    replaced,
    checks,
    reanchored,
    warnings,
  };
  ctx.print(json, [
    `Final round ${round.n} opened for ${slug}: ${s.round.changes.length} changes from round ` +
      `${s.round.n} → ${final.groups.length} commits`,
    ...(replaced ? [`  round ${replaced.n} is now ${replaced.status}`] : []),
    ...final.groups.map(
      (g) =>
        `  ${g.id.padEnd(4)} ${subject(g.message)}  (${g.changeIds.length} change${g.changeIds.length === 1 ? "" : "s"})`,
    ),
    `PR body: ${subject(final.prBody)}`,
    ...(reanchored.length ? [`Threads: ${describeReanchored(reanchored)}`] : []),
    ...warnings.map((w) => `warning: ${w}`),
  ]);
  return 0;
}

// ── lr final apply ────────────────────────────────────────────────────────────

/** `lr final apply --json` output. */
export interface FinalApplyOk {
  round: number;
  /** Undo point: `jj op restore <opBefore>` puts the stack back. */
  opBefore: string;
  /** The stack was rebased after the final round, so the checks ran again first. */
  rebased: boolean;
  opAfter: string;
  commits: {
    groupId: string;
    changeId: string;
    commitId: string;
    bookmarks: string[];
    subject: string;
  }[];
  prBody: string;
  prBodyPath: string;
}

/**
 * Squash the stack into the final commits a human approved: each group into its last change
 * (which keeps its change id and bookmarks), with the approved message. Checks that the result ends
 * in the tree it started from, and restores the jj operation from before if anything goes wrong.
 */
export async function finalApply(ctx: Context): Promise<number> {
  const feature = ctx.feature();
  const round = ctx.store.latestRound(feature.slug);
  if (feature.status !== "approved" || round?.kind !== "final" || round.verdict !== "approved") {
    throw new LrError(
      `nothing to apply: "${feature.slug}" is ${feature.status}, and \`lr final apply\` needs a ` +
        "final round a human approved (see `lr status`)",
    );
  }
  const final = round.final!;
  const drafts = new Drafts(join(ctx.featureDir(feature.slug), "final"));
  const changed = drafts.changedSince(final);
  if (changed.length) {
    throw new LrError(
      `the drafts changed since round ${round.n} was approved (${changed.join(", ")}); open a ` +
        "new final round with `lr review create --final`",
    );
  }
  const unsettled = ctx.store
    .listThreads(feature.slug)
    .filter((t) => t.status === "open" || t.status === "proposed");
  if (unsettled.length) {
    throw new LrError(`settle these threads first: ${unsettled.map((t) => `#${t.id}`).join(", ")}`);
  }
  const phases = ctx.store.getPlanVersion(feature.slug, round.planVersion)!.phases;
  const snap = await takeSnapshot(ctx.jj, feature.baseRevset, phases);
  const codeChanged = await codeChanges(ctx.jj, round.changes, snap.changes);
  if (codeChanged.length) {
    throw new LrError(
      `the code changed since final round ${round.n} (${codeChanged.join("; ")}); review it again ` +
        "with `lr review create`",
    );
  }
  const rebased = rewritten(snap, round);
  if (rebased) {
    const failed = (await checkStack(ctx, feature.slug, snap.changes, phases)).filter(
      (r) => r.run.status !== "pass",
    );
    if (failed.length) {
      throw new LrError(
        "checks fail on the rebased stack, so nothing was applied:\n" +
          failed
            .map(
              (r) =>
                `  ${r.run.status}: ${r.run.check} @ ${short(r.run.changeId)}  log: ${r.run.logPath}`,
            )
            .join("\n"),
      );
    }
  }

  const opBefore = snap.jjOpId;
  const tops = final.groups.map((g) => g.changeIds.at(-1)!);
  try {
    for (const g of final.groups) {
      const into = g.changeIds.at(-1)!;
      if (g.changeIds.length > 1) await ctx.jj.squash(g.changeIds.slice(0, -1), into, g.message);
      else await ctx.jj.describe(into, g.message);
    }
    // Squashing only regroups the changes, so the stack must end in the same tree.
    if (await ctx.jj.diffBetween(snap.changes.at(-1)!.commitId, tops.at(-1)!)) {
      throw new LrError("the squashed stack doesn't end in the tree it started from");
    }
  } catch (e) {
    await ctx.jj.restoreOp(opBefore);
    throw new LrError(
      `final apply failed, so the repo was restored to operation ${opBefore.slice(0, 12)}:\n` +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  const opAfter = await ctx.jj.snapshotOp();
  ctx.store.recordApply(feature.slug, { round: round.n, opBefore, opAfter, by: ctx.actor });

  const byChange = new Map((await ctx.jj.commits(tops.join("|"))).map((c) => [c.changeId, c]));
  const json: FinalApplyOk = {
    round: round.n,
    opBefore,
    rebased,
    opAfter,
    commits: final.groups.map((g, i) => {
      const c = byChange.get(tops[i]!)!;
      return {
        groupId: g.id,
        changeId: c.changeId,
        commitId: c.commitId,
        bookmarks: c.bookmarks,
        subject: subject(c.description),
      };
    }),
    prBody: final.prBody,
    prBodyPath: drafts.prBodyPath,
  };
  const top = json.commits.at(-1)!;
  ctx.print(json, [
    `Applied final round ${round.n}: ${round.changes.length} changes → ${json.commits.length} commits`,
    ...(rebased ? ["  (rebased after the approval: same code, and the checks pass on it)"] : []),
    ...json.commits.map(
      (c) =>
        `  ${short(c.changeId)} ${short(c.commitId)}  ${c.subject}` +
        (c.bookmarks.length ? `  [${c.bookmarks.join(", ")}]` : ""),
    ),
    `Undo with \`jj op restore ${opBefore.slice(0, 12)}\`.`,
    `PR body: ${json.prBodyPath}`,
    `Next: push the stack${top.bookmarks[0] ? ` (e.g. \`jj git push -b ${top.bookmarks[0]}\`)` : ""} and open a PR with that body.`,
  ]);
  return 0;
}

/** Whether a stack's commits were rewritten since a round (e.g. rebased), code aside. */
function rewritten(snap: Snapshot, round: Round): boolean {
  return stackCommits(snap) !== stackCommits(round);
}
