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
