// Small shared pieces: pills, badges, times, errors.
import type { ReactNode } from "react";
import type { Actor, CheckRun } from "../model.ts";
import type { ApiError } from "./api.ts";

export function formatActor(a: Actor): string {
  return `${a.kind}:${a.name}`;
}

export function ActorName({ actor }: { actor: Actor }) {
  return (
    <span className={`actor actor-${actor.kind}`} title={formatActor(actor)}>
      {actor.kind === "agent" ? "🤖 " : ""}
      {actor.name}
    </span>
  );
}

export function Pill({
  kind,
  children,
  testId,
}: {
  kind: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span className={`pill pill-${kind}`} data-testid={testId}>
      {children}
    </span>
  );
}

const CHECK_ICON: Record<CheckRun["status"], string> = {
  pass: "✓",
  fail: "✗",
  error: "!",
  running: "◌",
  pending: "·",
  skipped: "–",
};

export function CheckIcon({ run }: { run: CheckRun }) {
  return (
    <span className={`check check-${run.status}`} title={`${run.check}: ${run.status}`}>
      {CHECK_ICON[run.status]}
    </span>
  );
}

export function timeAgo(iso: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as const) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {timeAgo(iso)}
    </time>
  );
}

export function short(id: string): string {
  return id.slice(0, 8);
}

export function subject(description: string): string {
  return description.split("\n")[0] || "(no description)";
}

export function Loading() {
  return <p className="loading muted">Loading…</p>;
}

export function ErrorBox({ error }: { error: ApiError }) {
  return (
    <div className="error-box">
      <strong>{error.status === 401 ? "Not connected" : "Something went wrong"}</strong>
      <p>{error.message}</p>
    </div>
  );
}
