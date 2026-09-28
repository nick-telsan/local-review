import { timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import type { ReplyAction } from "../commands/thread.ts";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import type { Verdict } from "../model.ts";
import page from "../web/index.html";
import {
  addDraftComment,
  changeView,
  type DraftCommentInput,
  deleteDraftComment,
  discardDraft,
  features,
  replyToThread,
  roundView,
  saveDraftSummary,
  sinceView,
  submitDraft,
  updateDraftComment,
} from "./api.ts";

/** How often the server checks whether another process (the CLI, an agent) changed lr's state. */
export const POLL_MS = 500;

export interface UiServer {
  /** The page's address, with the token that unlocks the API. */
  url: string;
  port: number;
  token: string;
  stop(): Promise<void>;
}

type ApiRequest = Request & { params: Record<string, string> };
type Handler = (req: ApiRequest) => unknown;

/**
 * Serve the web UI and its API on 127.0.0.1. The page itself is public (it's the same bundle for
 * everyone); the API needs the token, sent as `Authorization: Bearer <token>`, so another site
 * open in the browser can't read or write reviews. It also refuses a Host other than this
 * server's, which defeats DNS rebinding, and writes from another origin.
 */
export function startUi(
  ctx: Context,
  opts: { port?: number; token?: string; dev?: boolean } = {},
): UiServer {
  const token =
    opts.token ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const events = new Events(ctx);

  const api = (handler: Handler, streaming = false) => {
    return async (req: ApiRequest) => {
      const refused = refuse(req, server.port!, token, streaming);
      if (refused) return refused;
      try {
        const result = await handler(req);
        return result instanceof Response ? result : Response.json(result);
      } catch (e) {
        if (e instanceof LrError) return Response.json({ error: e.message }, { status: 400 });
        console.error(e);
        return Response.json({ error: String(e) }, { status: 500 });
      }
    };
  };
  /** A write: its JSON body is passed along, and other open pages hear about the change. */
  const write = <T>(handler: (req: ApiRequest, body: T) => unknown) =>
    api(async (req) => {
      const result = await handler(req, await body<T>(req));
      events.notify();
      return result;
    });
  const round = (req: ApiRequest) => [ctx, req.params.slug!, req.params.n!] as const;

  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    development: opts.dev ? { hmr: true, console: true } : false,
    routes: {
      "/api/ping": api(() => ({ ok: true })),
      "/api/features": api(() => features(ctx)),
      "/api/features/:slug/rounds/:n": api((req) =>
        roundView(ctx, req.params.slug!, req.params.n!),
      ),
      "/api/features/:slug/rounds/:n/changes/:change": api((req) =>
        changeView(ctx, req.params.slug!, req.params.n!, req.params.change!),
      ),
      "/api/features/:slug/rounds/:n/since/:from": api((req) =>
        sinceView(...round(req), req.params.from!),
      ),
      "/api/features/:slug/rounds/:n/draft": {
        PUT: write<{ verdict: Verdict | null; body: string | null }>((req, b) =>
          saveDraftSummary(...round(req), b),
        ),
        DELETE: write((req) => discardDraft(...round(req))),
      },
      "/api/features/:slug/rounds/:n/draft/comments": {
        POST: write<DraftCommentInput>((req, b) => addDraftComment(...round(req), b)),
      },
      "/api/features/:slug/rounds/:n/draft/comments/:id": {
        PUT: write<DraftCommentInput>((req, b) =>
          updateDraftComment(...round(req), req.params.id!, b),
        ),
        DELETE: write((req) => deleteDraftComment(...round(req), req.params.id!)),
      },
      "/api/features/:slug/rounds/:n/draft/submit": {
        POST: write<{ verdict: Verdict | null; body: string | null }>((req, b) =>
          submitDraft(...round(req), b),
        ),
      },
      "/api/features/:slug/threads/:id/replies": {
        POST: write<{ action?: ReplyAction | null; body?: string | null }>((req, b) =>
          replyToThread(ctx, req.params.slug!, req.params.id!, b),
        ),
      },
      // EventSource can't send headers, so this one takes the token as `?t=`.
      "/api/events": api((req) => {
        server.timeout(req, 0);
        return events.subscribe(req.signal);
      }, true),
      "/api/*": api(() => Response.json({ error: "not found" }, { status: 404 })),
      "/*": page,
    },
  });

  const port = server.port!;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    async stop() {
      events.close();
      await server.stop(true);
    },
  };
}

/** The request's JSON body; `{}` when it has none (e.g. a DELETE). */
async function body<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LrError("the request body must be JSON");
  }
}

function refuse(req: Request, port: number, token: string, queryToken: boolean): Response | null {
  const host = req.headers.get("host");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return Response.json({ error: "unexpected Host" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && origin !== null && origin !== `http://${host}`) {
    return Response.json({ error: "cross-origin request" }, { status: 403 });
  }
  const auth = req.headers.get("authorization");
  const given = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : queryToken
      ? new URL(req.url).searchParams.get("t")
      : null;
  if (given === null || !same(given, token)) {
    return Response.json(
      { error: "missing or wrong token; open the UI with the link `lr ui` prints" },
      { status: 401 },
    );
  }
  return null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Server-sent events telling the page lr's state changed, so it refetches. Other processes write
 * to the same SQLite database, and `PRAGMA data_version` changes when they commit.
 */
class Events {
  private readonly clients = new Set<ReadableStreamDefaultController<string>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private version = -1;

  constructor(private readonly ctx: Context) {}

  subscribe(signal: AbortSignal): Response {
    let client: ReadableStreamDefaultController<string>;
    const stream = new ReadableStream<string>({
      start: (controller) => {
        client = controller;
        this.clients.add(controller);
        controller.enqueue(": connected\n\n");
        this.poll();
      },
      cancel: () => this.drop(client),
    });
    signal.addEventListener("abort", () => this.drop(client));
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  /** Tell every page to refetch. */
  notify(): void {
    for (const c of this.clients) c.enqueue("data: changed\n\n");
  }

  close(): void {
    for (const c of this.clients) c.close();
    this.clients.clear();
    this.stopPolling();
  }

  private poll(): void {
    if (this.timer) return;
    this.version = this.dataVersion();
    this.timer = setInterval(() => {
      const v = this.dataVersion();
      if (v !== this.version) {
        this.version = v;
        this.notify();
      }
    }, POLL_MS);
  }

  private drop(client: ReadableStreamDefaultController<string>): void {
    this.clients.delete(client);
    if (this.clients.size === 0) this.stopPolling();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private dataVersion(): number {
    const row = this.ctx.store.db.query("PRAGMA data_version").get() as { data_version: number };
    return row.data_version;
  }
}
