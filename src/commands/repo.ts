import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkWorkspaceDir, checkWorkspaceName } from "../checks.ts";
import type { Io } from "../context.ts";
import { LrError } from "../errors.ts";
import { Jj } from "../jj.ts";
import { orphanedRepos, repoDir } from "../paths.ts";
import { Store } from "../store.ts";

/** `lr repo relink --json` output. */
export interface RepoRelinkOk {
  /** Where the repo was. */
  from: string;
  /** Where it is now. */
  to: string;
  features: string[];
  /** Checks workspaces forgotten, since jj can't follow them; the next check run makes new ones. */
  workspaces: string[];
}

/**
 * Bring a moved repo's review history along. lr keys its state by the repo's path, so after a
 * move it finds none. Without `from`, lr looks for history whose repo is gone and whose recorded
 * commits this repo has.
 */
export async function repoRelink(
  io: Io,
  fromArg: string | undefined,
  opts: { repo?: string; json?: boolean },
): Promise<number> {
  const jj = await Jj.discover(opts.repo ?? process.cwd());
  const to = jj.root;
  const from = fromArg === undefined ? await findMoved(jj) : await checkMoved(jj, resolve(fromArg));
  const fromDir = repoDir(from);
  const toDir = repoDir(to);

  // Running any lr command here before relinking leaves empty state behind; replace that.
  if (existsSync(toDir)) {
    const here = await Store.open(to);
    const slugs = here.listFeatures().map((f) => f.slug);
    here.close();
    if (slugs.length) {
      throw new LrError(
        `this repo already has review history (${slugs.join(", ")}), so lr can't bring ${from}'s along`,
      );
    }
  }

  const store = await Store.open(from);
  const features = store.listFeatures().map((f) => f.slug);
  // A checks workspace points at the repo by a relative path, which the move broke.
  const known = await jj.workspaceNames();
  const workspaces: string[] = [];
  for (const slug of features) {
    const name = checkWorkspaceName(slug);
    if (known.includes(name)) {
      await jj.forgetWorkspace(name);
      workspaces.push(slug);
    }
    rmSync(checkWorkspaceDir(join(fromDir, slug)), { recursive: true, force: true });
  }
  store.relocateLogs(fromDir, toDir);
  store.close();

  rmSync(toDir, { recursive: true, force: true });
  renameSync(fromDir, toDir);
  const repoJson = join(toDir, "repo.json");
  const { createdAt } = JSON.parse(readFileSync(repoJson, "utf8")) as { createdAt: string };
  await Bun.write(repoJson, `${JSON.stringify({ root: to, createdAt }, null, 2)}\n`);

  const json: RepoRelinkOk = { from, to, features, workspaces };
  const text = [
    `Relinked ${from} → ${to}: ` +
      (features.length
        ? `${features.length} feature${features.length === 1 ? "" : "s"} (${features.join(", ")})`
        : "no features"),
  ];
  if (workspaces.length) {
    text.push(
      `Forgot the checks workspace of ${workspaces.join(", ")}; the next check run makes a new one.`,
    );
  }
  io.out(opts.json ? JSON.stringify(json, null, 2) : text.join("\n"));
  return 0;
}

/** Check that `from` is history for a repo that moved, and that it's this one. */
async function checkMoved(jj: Jj, from: string): Promise<string> {
  if (from === jj.root) throw new LrError(`this repo is already at ${from}`);
  if (!existsSync(join(repoDir(from), "state.db"))) {
    throw new LrError(`lr has no review history for ${from}`);
  }
  if (existsSync(join(from, ".jj"))) {
    throw new LrError(
      `${from} is still a jj repo; relink is for a repo that moved, and its history stays there`,
    );
  }
  if ((await matches(jj, from)) === false) {
    throw new LrError(`this repo has none of the commits ${from}'s review rounds recorded`);
  }
  return from;
}

/** The one moved repo whose history this repo matches. */
async function findMoved(jj: Jj): Promise<string> {
  const gone = orphanedRepos().filter((o) => o.root !== jj.root);
  const found: string[] = [];
  for (const o of gone) if (await matches(jj, o.root)) found.push(o.root);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) {
    throw new LrError(
      `the history of several moved repos matches this one (${found.join(", ")}); pick one with ` +
        "`lr repo relink <old path>`",
    );
  }
  throw new LrError(
    "found no review history whose recorded commits are in this repo; pass the path it moved " +
      "from: `lr repo relink <old path>`" +
      (gone.length
        ? `\nHistory for repos that are gone: ${gone.map((o) => o.root).join(", ")}`
        : ""),
  );
}

/**
 * Whether this repo has the commits `root`'s latest rounds recorded (null: no rounds to compare).
 * Any one is enough: gc may have dropped the rest.
 */
async function matches(jj: Jj, root: string): Promise<boolean | null> {
  const store = await Store.open(root);
  const ids = store.listFeatures().flatMap((f) => {
    const round = store.latestRound(f.slug);
    return round ? [round.baseCommitId, ...round.changes.map((c) => c.commitId)] : [];
  });
  store.close();
  if (!ids.length) return null;
  return (await jj.presentCommits(ids)).length > 0;
}
