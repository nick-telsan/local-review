import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../checks.ts";
import { repoDir } from "../paths.ts";

/** Where a running `lr ui` records itself, so other lr commands can link to it. */
export interface UiInfo {
  pid: number;
  port: number;
  token: string;
}

export function uiInfoPath(root: string): string {
  return join(repoDir(root), "ui.json");
}

export function readUiInfo(path: string): UiInfo | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UiInfo;
  } catch {
    return null;
  }
}

/** A round's page in the UI. */
export function roundPath(slug: string, n: number): string {
  return `/f/${encodeURIComponent(slug)}/r/${n}`;
}

/**
 * A link to `path` in this repo's UI, or null when no `lr ui` is running for it. The link leaves
 * out the token: output like this ends up in transcripts and handoffs, and the browser `lr ui`
 * opened already keeps the token for that server. It's the origin `lr ui` prints, because the
 * browser keeps the token per origin.
 */
export function uiLink(root: string, path: string): string | null {
  const info = readUiInfo(uiInfoPath(root));
  return info && processAlive(info.pid) ? `http://127.0.0.1:${info.port}${path}` : null;
}
