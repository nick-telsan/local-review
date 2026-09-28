import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";

const NAVIGATE = "lr:navigate";

function subscribe(onChange: () => void): () => void {
  addEventListener("popstate", onChange);
  addEventListener(NAVIGATE, onChange);
  return () => {
    removeEventListener("popstate", onChange);
    removeEventListener(NAVIGATE, onChange);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  dispatchEvent(new Event(NAVIGATE));
  if (!opts.replace) scrollTo(0, 0);
}

/** A link that navigates in the page, and still opens in a new tab with a modifier key. */
export function Link({ to, ...props }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={onClick} {...props} />;
}

/** Match `path` against a pattern like `/f/:slug/r/:n`; null if it doesn't match. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.replace(/\/$/, "").split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(":")) params[w.slice(1)] = decodeURIComponent(g);
    else if (w !== g) return null;
  }
  return params;
}
