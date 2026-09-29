import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { processAlive } from "../checks.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import { readUiInfo, type UiInfo, uiInfoPath } from "../ui/running.ts";
import { startUi } from "../ui/server.ts";

/** `lr ui --json` output, printed once the UI is ready. */
export interface UiOk {
  /** The link to open, with the token that unlocks the API. */
  url: string;
  /** Another `lr ui` for this repo was already serving it; this one just opened the link. */
  reused: boolean;
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Older Bun (1.3) bundles the page with asset paths relative to the working directory. */
export const MIN_BUN = "1.4.2";

/**
 * Serve the review UI for this repo until Ctrl-C, and open it in the browser. If this repo's UI
 * is already running, open that one instead. It lands on the current feature, if there is one.
 */
export async function ui(
  ctx: Context,
  opts: { port?: string; open: boolean; dev?: boolean; bunVersion?: string },
): Promise<number> {
  if (Bun.semver.order(opts.bunVersion ?? Bun.version, MIN_BUN) < 0) {
    throw new LrError(
      `the UI needs Bun ${MIN_BUN} or later, and this is ${opts.bunVersion ?? Bun.version} ` +
        "(if lr runs through a shim, check which bun it resolves outside this repo)",
    );
  }
  const port = opts.port === undefined ? undefined : Number(opts.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new LrError(`--port must be a port number, not "${opts.port}"`);
  }
  const landing = landingPath(ctx);
  const infoPath = uiInfoPath(ctx.jj.root);

  const running = await runningUi(infoPath);
  if (running) {
    const url = link(`http://127.0.0.1:${running.port}/`, landing, running.token);
    ctx.print({ url, reused: true }, [`The review UI is already running: ${url}`]);
    if (opts.open) openBrowser(url);
    return 0;
  }

  let server: ReturnType<typeof startUi>;
  try {
    server = startUi(ctx, { port, dev: opts.dev });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new LrError(`port ${port} is in use; pick another with --port, or leave it out`);
    }
    throw e;
  }
  const info: UiInfo = { pid: process.pid, port: server.port, token: server.token };
  writeFileSync(infoPath, JSON.stringify(info));
  chmodSync(infoPath, 0o600); // the token unlocks the API

  const url = link(server.url, landing, server.token);
  ctx.print({ url, reused: false }, [`Review UI: ${url}`]);
  ctx.io.err("Ctrl-C to stop.");
  if (opts.open) openBrowser(url);

  await new Promise<void>((resolve) => {
    const stop = () => {
      for (const s of STOP_SIGNALS) process.off(s, stop);
      resolve();
    };
    for (const s of STOP_SIGNALS) process.on(s, stop);
  });
  await server.stop();
  if (readUiInfo(infoPath)?.pid === process.pid) rmSync(infoPath, { force: true });
  return 0;
}

/** The current feature's latest round, or the feature list when there's no one feature. */
function landingPath(ctx: Context): string {
  try {
    return `/f/${encodeURIComponent(ctx.feature().slug)}`;
  } catch (e) {
    if (e instanceof LrError) return "/";
    throw e;
  }
}

function link(origin: string, path: string, token: string): string {
  return `${origin.replace(/\/$/, "")}${path}?t=${token}`;
}

/** The UI another lr is serving for this repo, if it's still up. */
async function runningUi(path: string): Promise<UiInfo | null> {
  const info = readUiInfo(path);
  if (!info || !processAlive(info.pid)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/ping`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? info : null;
  } catch {
    return null;
  }
}

/** `$BROWSER` if set (the usual Unix convention), else the platform's opener. */
function openBrowser(url: string): void {
  const opener = process.env.BROWSER || (process.platform === "darwin" ? "open" : "xdg-open");
  try {
    Bun.spawn([opener, url], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // No opener (e.g. a headless box): the link is printed.
  }
}
