import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkWorkspaceDir, checkWorkspaceName } from "../checks.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import { type Jj, revsetString } from "../jj.ts";
import type { Feature } from "../model.ts";
import { movedHint } from "../paths.ts";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** `lr feature start --json` output. */
export interface FeatureStartOk {
  feature: Feature;
  dir: string;
  /** What the base resolved to now; a round resolves it again. */
  base: { commitId: string; changeId: string; root: boolean };
  warnings: string[];
}

export async function featureStart(
  ctx: Context,
  slug: string | undefined,
  opts: { title?: string; base?: string },
): Promise<number> {
  if (!slug || !SLUG.test(slug)) {
    throw new LrError(
      "usage: lr feature start <slug> [--title <title>] [--base <revset>]\n" +
        "slug: lowercase letters, digits, and dashes",
    );
  }
  const baseRevset = opts.base ?? "trunk()";
  const jj = ctx.jj.at(await ctx.jj.snapshotOp());
  // Fail early on a revset that doesn't resolve.
  await jj.run(["log", "--no-graph", "--limit", "1", "-r", baseRevset, "-T", "commit_id"]);
  const [base] = await jj.commits(`latest(${baseRevset})`);
  const warnings = await baseWarnings(jj, baseRevset, opts.base === undefined);

  const feature = ctx.store.createFeature({ slug, title: opts.title ?? slug, baseRevset });
  const root = base!.commitId === ROOT_COMMIT;
  const json: FeatureStartOk = {
    feature,
    dir: ctx.featureDir(slug),
    base: { commitId: base!.commitId, changeId: base!.changeId, root },
    warnings,
  };
  const at = root
    ? "the root commit"
    : `now ${base!.changeId.slice(0, 8)}${base!.description ? ` "${firstLine(base!.description)}"` : ""}`;
  ctx.print(json, [
    `Started feature ${slug} (base: ${baseRevset}, ${at})`,
    ...warnings.map((w) => `warning: ${w}`),
    `State: ${ctx.featureDir(slug)}`,
    `Next: write a plan and run \`lr plan submit -F <file>\``,
  ]);
  return 0;
}

const ROOT_COMMIT = "0".repeat(40);

const firstLine = (text: string) => text.split("\n")[0]!;

/**
 * Catch a base that would sweep commits into the feature that aren't its own: one below
 * bookmarks that @ builds on (`trunk()` finds only a remote's main bookmark, so in a repo with no
 * remote it's the root commit). With the default base, that's an error; a base given by name is
 * taken as meant, with a warning.
 */
async function baseWarnings(jj: Jj, baseRevset: string, defaulted: boolean): Promise<string[]> {
  const base = `(${baseRevset})`;
  const ahead = await jj.commits(`heads((${base}::@ ~ ${base}) & bookmarks())`);
  const isRoot = (await jj.commits(`${base} & root()`)).length > 0;
  const named = ahead.flatMap((c) => c.bookmarks);
  if (named.length === 0) {
    return isRoot && defaulted
      ? [
          "trunk() is the root commit, so this feature covers the repo's whole history. That's " +
            "right for a new repo; otherwise start it from a bookmark with --base.",
        ]
      : [];
  }

  const many = named.length > 1;
  const problem =
    `@ builds on ${many ? "bookmarks" : "bookmark"} ${named.join(", ")}, above the base ` +
    `(${baseRevset}${isRoot ? ", the root commit" : ""}): the feature would include ` +
    `${many ? "their" : "its"} commits`;
  if (!defaulted) return [problem];
  const lines = [
    `${problem}.`,
    `Start it from there: lr feature start <slug> --base ${revsetArg(named[0]!)}`,
  ];
  if (isRoot) {
    lines.push(
      "(trunk() looks for main, master, or trunk on a remote, and found none. To point it at " +
        `${named[0]} in this repo: jj config set --repo 'revset-aliases."trunk()"' ${revsetArg(named[0]!)})`,
    );
  }
  lines.push("To start from trunk() anyway, pass --base 'trunk()'.");
  throw new LrError(lines.join("\n"));
}

/** A bookmark name as it'd be typed in a shell command line. */
function revsetArg(name: string): string {
  return /^[\w./-]+$/.test(name) ? name : `'${revsetString(name)}'`;
}

export async function featureList(ctx: Context): Promise<number> {
  const features = ctx.store.listFeatures();
  ctx.print(
    { features },
    features.length === 0
      ? `No features yet${movedHint(ctx.jj.root)}.`
      : features.map(
          (f) =>
            `${f.slug.padEnd(24)} ${f.status.padEnd(13)} plan v${f.currentPlanVersion ?? "-"}  ${f.title}`,
        ),
  );
  return 0;
}

const FINISHED: Feature["status"][] = ["done", "abandoned"];

/** `lr feature abandon --json` output. */
export interface FeatureAbandonOk {
  feature: Feature;
}

/** Give up on a feature. Its review history stays; `lr feature clean` tidies up the repo. */
export async function featureAbandon(ctx: Context, slug: string | undefined): Promise<number> {
  if (ctx.actor.kind !== "human") {
    throw new LrError("only a human can abandon a feature (pass --as human:<you>)");
  }
  const feature = slug ? getFeature(ctx, slug) : ctx.feature();
  if (FINISHED.includes(feature.status)) {
    throw new LrError(`feature "${feature.slug}" is already ${feature.status}`);
  }
  ctx.store.setFeatureStatus(feature.slug, "abandoned");
  const json: FeatureAbandonOk = { feature: ctx.store.getFeature(feature.slug)! };
  ctx.print(json, [
    `Abandoned ${feature.slug}. Its review history is kept, and so are its commits.`,
    `Next: \`lr feature clean ${feature.slug}\` forgets its bookmarks and check workspace.`,
  ]);
  return 0;
}

/** `lr feature clean --json` output. */
export interface FeatureCleanOk {
  features: {
    slug: string;
    /** Phase bookmarks forgotten: they were still where lr last saw them. */
    forgotten: string[];
    /** Phase bookmarks left alone, and why. */
    kept: { bookmark: string; reason: string }[];
    /** Whether a checks workspace was removed. */
    workspace: boolean;
    /** Whether the review history was deleted (`--purge`). */
    purged: boolean;
  }[];
  /** Undo point for the bookmark and workspace changes; null if jj wasn't touched. */
  opBefore: string | null;
}

/**
 * Tidy up after finished (done or abandoned) features: all of them, or the ones named. Forgets
 * phase bookmarks that are still where lr last saw them, and removes the checks workspace. Review
 * history stays unless `--purge`. Commits are never touched.
 */
export async function featureClean(
  ctx: Context,
  slugs: string[],
  opts: { purge?: boolean },
): Promise<number> {
  if (opts.purge && slugs.length === 0) {
    throw new LrError(
      "--purge deletes review history for good, so name the features: lr feature clean <slug>… --purge",
    );
  }
  if (opts.purge && ctx.actor.kind !== "human") {
    throw new LrError("only a human can --purge review history (pass --as human:<you>)");
  }
  const features = slugs.length
    ? slugs.map((s) => getFeature(ctx, s))
    : ctx.store.listFeatures().filter((f) => FINISHED.includes(f.status));
  for (const f of features) {
    if (!FINISHED.includes(f.status)) {
      throw new LrError(
        `feature "${f.slug}" is ${f.status}; clean it once it's done, or abandon it first ` +
          `(\`lr feature abandon ${f.slug}\`)`,
      );
    }
  }
  if (features.length === 0) {
    ctx.print({ features: [], opBefore: null } satisfies FeatureCleanOk, "No finished features.");
    return 0;
  }

  const opBefore = await ctx.jj.snapshotOp();
  const workspaces = await ctx.jj.workspaceNames();
  const json: FeatureCleanOk = { features: [], opBefore: null };
  for (const f of features) {
    const result = await cleanFeature(ctx, f, workspaces, opts.purge ?? false);
    if (result.forgotten.length || workspaces.includes(checkWorkspaceName(f.slug))) {
      json.opBefore = opBefore;
    }
    json.features.push(result);
  }

  const lines: string[] = [];
  for (const r of json.features) {
    const done = [
      r.forgotten.length && `forgot ${r.forgotten.join(", ")}`,
      r.workspace && "removed its checks workspace",
      r.purged && "deleted its review history",
    ].filter(Boolean);
    lines.push(`${r.slug}: ${done.length ? done.join("; ") : "nothing to clean"}`);
    for (const k of r.kept) lines.push(`  kept ${k.bookmark}: ${k.reason}`);
  }
  if (json.opBefore) {
    lines.push(`Undo the jj changes with \`jj op restore ${json.opBefore.slice(0, 12)}\`.`);
  }
  if (!opts.purge) lines.push("Review history is kept (`--purge` deletes it).");
  ctx.print(json, lines);
  return 0;
}

async function cleanFeature(
  ctx: Context,
  feature: Feature,
  workspaces: string[],
  purge: boolean,
): Promise<FeatureCleanOk["features"][number]> {
  const slug = feature.slug;
  const round = ctx.store.latestRound(slug);
  // Phase bookmarks from the current plan and from the plan the last round was taken under.
  const versions = [feature.currentPlanVersion, round?.planVersion].filter((v) => v != null);
  const names = [
    ...new Set(
      versions.flatMap((v) => ctx.store.getPlanVersion(slug, v)!.phases.map((p) => p.bookmark)),
    ),
  ];
  // Where the last round saw each one: the change it was on.
  const seen = new Map<string, string>();
  for (const c of round?.changes ?? []) {
    for (const b of c.bookmarks) if (names.includes(b)) seen.set(b, c.changeId);
  }

  const targets = names.length
    ? await ctx.jj.commits(names.map((b) => `present(${revsetString(b)})`).join(" | "))
    : [];
  const forgotten: string[] = [];
  const kept: { bookmark: string; reason: string }[] = [];
  for (const b of names) {
    const on = targets.filter((c) => c.bookmarks.includes(b));
    if (on.length === 0) continue;
    const was = seen.get(b);
    if (on.length > 1) kept.push({ bookmark: b, reason: "it's conflicted" });
    else if (!was) kept.push({ bookmark: b, reason: "no review round recorded where it was" });
    else if (on[0]!.changeId !== was) {
      kept.push({
        bookmark: b,
        reason: `it moved since round ${round!.n} (from ${was.slice(0, 8)} to ${on[0]!.changeId.slice(0, 8)})`,
      });
    } else forgotten.push(b);
  }
  await ctx.jj.forgetBookmarks(forgotten);

  const name = checkWorkspaceName(slug);
  const dir = checkWorkspaceDir(ctx.featureDir(slug));
  const workspace = workspaces.includes(name) || existsSync(dir);
  if (workspaces.includes(name)) await ctx.jj.forgetWorkspace(name);
  rmSync(join(dir, ".."), { recursive: true, force: true });

  if (purge) {
    ctx.store.deleteFeature(slug);
    rmSync(ctx.featureDir(slug), { recursive: true, force: true });
  }
  return { slug, forgotten, kept, workspace, purged: purge };
}

function getFeature(ctx: Context, slug: string): Feature {
  const feature = ctx.store.getFeature(slug);
  if (!feature) throw new LrError(`no feature "${slug}" in this repo`);
  return feature;
}
