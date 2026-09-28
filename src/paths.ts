import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export function lrHome(): string {
  return process.env.LOCAL_REVIEW_HOME ?? join(homedir(), ".local-review");
}

/** `<dirname>-<6 hex chars of sha256(root)>`: readable, and unique per checkout. */
export function repoKey(root: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 6);
  return `${basename(root)}-${hash}`;
}

export function repoDir(root: string): string {
  return join(lrHome(), repoKey(root));
}

export function featureDir(root: string, slug: string): string {
  return join(repoDir(root), slug);
}

/** Review history for repos that are gone from where lr saw them: moved, or deleted. */
export function orphanedRepos(): { root: string; dir: string }[] {
  const home = lrHome();
  if (!existsSync(home)) return [];
  const found: { root: string; dir: string }[] = [];
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    const dir = join(home, entry.name);
    const repoJson = join(dir, "repo.json");
    if (!entry.isDirectory() || !existsSync(repoJson)) continue;
    const { root } = JSON.parse(readFileSync(repoJson, "utf8")) as { root: string };
    if (!existsSync(join(root, ".jj"))) found.push({ root, dir });
  }
  return found;
}

/** A hint for a repo with no review history that may have moved from where lr last saw it. */
export function movedHint(root: string): string {
  const same = orphanedRepos().filter((o) => basename(o.root) === basename(root));
  if (!same.length) return "";
  return `; if this repo moved from ${same.map((o) => o.root).join(" or ")}, \`lr repo relink\` brings its review history along`;
}
