import { LrError } from "./errors.ts";
import type { Actor } from "./model.ts";

/**
 * Parse `agent:claude-code`, `human:nick`, or a bare name (treated as human).
 * Falls back to $LR_ACTOR, then to the current OS user.
 */
export function resolveActor(flag: string | undefined): Actor {
  const spec = flag ?? process.env.LR_ACTOR;
  if (!spec) return { kind: "human", name: process.env.USER ?? "unknown" };
  const [kind, name] = spec.includes(":") ? spec.split(":", 2) : ["human", spec];
  if ((kind !== "human" && kind !== "agent") || !name) {
    throw new LrError(`invalid actor "${spec}" (expected human:<name>, agent:<name>, or <name>)`);
  }
  return { kind, name };
}

export function formatActor(actor: Actor): string {
  return `${actor.kind}:${actor.name}`;
}

export function parseActor(text: string): Actor {
  return resolveActor(text);
}
