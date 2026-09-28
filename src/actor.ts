import { LrError } from "./errors.ts";
import type { Actor } from "./model.ts";

/**
 * Parse `agent:claude-code`, `human:nick`, or a bare name (treated as human).
 * Falls back to $LR_ACTOR, then to the coding agent running us, then to the current OS user.
 */
export function resolveActor(flag: string | undefined): Actor {
  const spec = flag ?? process.env.LR_ACTOR;
  if (!spec) return detectAgent() ?? { kind: "human", name: process.env.USER ?? "unknown" };
  return parseSpec(spec);
}

/**
 * The coding agent whose shell we're running in, if any. Defaulting to it (and not the OS user)
 * means an agent that forgets `--as` can't record a human's verdict.
 */
function detectAgent(): Actor | null {
  // Claude Code sets CLAUDECODE=1; AI_AGENT (e.g. `claude-code_2-1-283_agent`) names the tool.
  const tool = process.env.AI_AGENT?.split("_")[0];
  if (tool) return { kind: "agent", name: tool };
  if (process.env.CLAUDECODE === "1") return { kind: "agent", name: "claude-code" };
  return null;
}

function parseSpec(spec: string): Actor {
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
  return parseSpec(text);
}

/**
 * Who `lr ui` acts as. A person uses it, so it never defaults to the coding agent whose shell
 * started it: `--as` or $LR_ACTOR if either names a human, else the OS user.
 */
export function resolveHuman(flag: string | undefined): Actor {
  const spec = flag ?? process.env.LR_ACTOR;
  const actor: Actor = spec
    ? parseSpec(spec)
    : { kind: "human", name: process.env.USER ?? "unknown" };
  if (actor.kind !== "human") {
    throw new LrError(
      `the UI acts for a person, not ${formatActor(actor)}; pass --as human:<name>`,
    );
  }
  return actor;
}
