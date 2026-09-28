import { useEffect, useState } from "react";

// The server prints a link with `?t=<token>`. Keep the token for this server (its port) and take
// it out of the address bar, so a copied link doesn't carry it.
const KEY = `lr-token:${location.port}`;
let token: string | null = null;

function getToken(): string | null {
  if (token !== null) return token;
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("t");
  if (fromUrl) {
    url.searchParams.delete("t");
    history.replaceState(history.state, "", url);
    try {
      localStorage.setItem(KEY, fromUrl);
    } catch {
      // Storage can be blocked; the token still works for this page.
    }
    token = fromUrl;
    return token;
  }
  try {
    token = localStorage.getItem(KEY);
  } catch {
    token = null;
  }
  return token;
}
getToken();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { authorization: `Bearer ${getToken() ?? ""}` },
  });
  const body = (await res.json()) as T | { error: string };
  if (!res.ok) throw new ApiError((body as { error: string }).error, res.status);
  return body as T;
}

/** A write. Everything shown refetches afterwards (other pages hear via the event stream). */
export async function send<T>(method: string, path: string, data?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${getToken() ?? ""}`,
      "content-type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = (await res.json()) as T | { error: string };
  if (!res.ok) throw new ApiError((body as { error: string }).error, res.status);
  for (const l of listeners) l();
  return body as T;
}

// One event stream per page; each `useApi` refetches when lr's state changes.
const listeners = new Set<() => void>();
let source: EventSource | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!source) {
    source = new EventSource(`/api/events?t=${encodeURIComponent(getToken() ?? "")}`);
    source.onmessage = () => {
      for (const l of listeners) l();
    };
    // After a reconnect, whatever changed while disconnected is unknown: refetch.
    source.onopen = () => {
      for (const l of listeners) l();
    };
  }
  return () => {
    listeners.delete(listener);
  };
}

export interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
}

/** GET `path`, refetched when it changes and whenever lr's state does. Keeps the last data. */
export function useApi<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<Loaded<T> & { path: string | null }>({
    data: null,
    error: null,
    path: null,
  });

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    const load = () => {
      get<T>(path).then(
        (data) => !cancelled && setState({ data, error: null, path }),
        (error: ApiError) => !cancelled && setState((s) => ({ ...s, error, path })),
      );
    };
    load();
    const unsubscribe = subscribe(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [path]);

  // Data for another path is stale; don't show it as this one's.
  return state.path === path ? state : { data: null, error: null };
}
