import { parseArgs } from "node:util";
import { resolveHuman } from "./actor.ts";
import { check } from "./commands/check.ts";
import { diff } from "./commands/diff.ts";
import { featureAbandon, featureClean, featureList, featureStart } from "./commands/feature.ts";
import {
  finalApply,
  finalCut,
  finalMessage,
  finalPrBody,
  finalRoundCreate,
  finalShow,
} from "./commands/final.ts";
import { handoff } from "./commands/handoff.ts";
import { HOOK_EVENTS, hook } from "./commands/hook.ts";
import { note } from "./commands/note.ts";
import { planShow, planSubmit } from "./commands/plan.ts";
import { rebase } from "./commands/rebase.ts";
import { repoRelink } from "./commands/repo.ts";
import { reviewCreate } from "./commands/review.ts";
import { status } from "./commands/status.ts";
import { reviewSubmit } from "./commands/submit.ts";
import { type ReplyAction, reply, threads } from "./commands/thread.ts";
import { ui } from "./commands/ui.ts";
import { Context, type Io } from "./context.ts";
import { LrError } from "./errors.ts";

const USAGE = `lr — local review for agentic development

Usage:
  lr feature start <slug> [--title <title>] [--base <revset>]
  lr feature list
  lr feature abandon [<slug>]
  lr feature clean [<slug>…] [--purge]
                                  forget finished features' bookmarks and check workspaces
  lr plan submit -F <file>        first plan for the feature (- for stdin)
  lr plan revise -F <file>        a revised plan after review
  lr plan show
  lr note <change> [<path>:<line>[-<line>] [--old]] "<text>"
                                  a note for reviewers on your change, instead of a code comment
  lr review create [--allow-failing] [--skip-checks]
  lr check [<change>…] [--check <name,…>] [--round <n>] [--rerun]
                                  run checks by hand: on the stack now, or on a round's commits
  lr review create --final        a final round: the squash groups, messages, and PR body
  lr review submit [-F <review.json>] [--verdict approved|changes_requested] [-m <body>]
                   [--round <n>]      record a review on the latest (or given) open round
  lr handoff [--round <n>]        what the author needs to act on after a review
  lr diff [<change>] [--from <n>] [--to <n>] [--name-only]
                                  what changed between rounds (default: since your last review)
  lr threads [--status <s,…> | --all] [--notes]
  lr reply <thread> [--addressed|--resolve|--dismiss|--reopen|--accept] [<message>]
  lr final show                   the final commits (one per phase) and their drafts
  lr final message <group> -F <file>
  lr final pr-body -F <file>
  lr final cut <change> [--remove]
                                  start a new final commit at a change, splitting its phase
  lr final apply                  squash the stack as approved in the final round
  lr rebase [--onto <revset>]     rebase the stack onto its base (--onto: a new base)
  lr status
  lr ui [--port <n>] [--no-open]  the review UI in your browser (Ctrl-C stops it)
  lr repo relink [<old path>]    bring review history along after the repo moved
  lr hook ${HOOK_EVENTS.join("|")}
                                  Claude Code hook handlers (hook JSON on stdin)

Global options:
  -R, --repo <path>     repository (default: current directory)
  --feature <slug>      feature to act on (default: $LR_FEATURE, or the only active one)
  --as <actor>          who is acting: human:<name> | agent:<name> (default: $LR_ACTOR, else
                        agent:<name> inside a coding agent such as Claude Code, else $USER)
  --json                machine-readable output
`;

const GLOBAL = {
  repo: { type: "string", short: "R" },
  feature: { type: "string" },
  as: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Handler = (ctx: Context, args: string[]) => Promise<number>;

const COMMANDS: Record<string, Handler> = {
  "feature start": async (ctx, args) => {
    const { values, positionals } = parse(args, {
      title: { type: "string" },
      base: { type: "string" },
    });
    return featureStart(ctx, positionals[0], values);
  },
  "feature list": async (ctx, args) => {
    parse(args, {});
    return featureList(ctx);
  },
  "feature abandon": async (ctx, args) => {
    const { positionals } = parse(args, {});
    return featureAbandon(ctx, positionals[0]);
  },
  "feature clean": async (ctx, args) => {
    const { values, positionals } = parse(args, { purge: { type: "boolean" } });
    return featureClean(ctx, positionals, values);
  },
  "plan submit": async (ctx, args) => planSubmit(ctx, "submit", parse(args, FILE).values.file),
  "plan revise": async (ctx, args) => planSubmit(ctx, "revise", parse(args, FILE).values.file),
  "plan show": async (ctx, args) => {
    parse(args, {});
    return planShow(ctx);
  },
  note: async (ctx, args) => {
    const { values, positionals } = parse(args, {
      message: { type: "string", short: "m" },
      old: { type: "boolean" },
    });
    return note(ctx, positionals, values);
  },
  check: async (ctx, args) => {
    const { values, positionals } = parse(args, {
      check: { type: "string" },
      round: { type: "string" },
      rerun: { type: "boolean" },
    });
    return check(ctx, positionals, values);
  },
  diff: async (ctx, args) => {
    const { values, positionals } = parse(args, {
      from: { type: "string" },
      to: { type: "string" },
      "name-only": { type: "boolean" },
    });
    return diff(ctx, positionals[0], { ...values, nameOnly: values["name-only"] });
  },
  "review create": async (ctx, args) => {
    const { values } = parse(args, {
      "allow-failing": { type: "boolean" },
      "skip-checks": { type: "boolean" },
      final: { type: "boolean" },
    });
    if (values.final) {
      if (values["allow-failing"] || values["skip-checks"]) {
        throw new LrError(
          "--final reuses the approved round's checks (rerunning them after a rebase), so it " +
            "takes no --allow-failing/--skip-checks",
        );
      }
      return finalRoundCreate(ctx);
    }
    return reviewCreate(ctx, {
      allowFailing: values["allow-failing"],
      skipChecks: values["skip-checks"],
    });
  },
  "review submit": async (ctx, args) => {
    const { values } = parse(args, {
      ...FILE,
      verdict: { type: "string" },
      message: { type: "string", short: "m" },
      round: { type: "string" },
    });
    return reviewSubmit(ctx, {
      file: values.file,
      verdict: values.verdict,
      body: values.message,
      round: values.round,
    });
  },
  handoff: async (ctx, args) => {
    const { values } = parse(args, { round: { type: "string" } });
    return handoff(ctx, { round: values.round });
  },
  threads: async (ctx, args) => {
    const { values } = parse(args, {
      status: { type: "string" },
      all: { type: "boolean" },
      notes: { type: "boolean" },
    });
    return threads(ctx, values);
  },
  reply: async (ctx, args) => {
    const flags = {
      addressed: { type: "boolean" },
      resolve: { type: "boolean" },
      dismiss: { type: "boolean" },
      reopen: { type: "boolean" },
      accept: { type: "boolean" },
    } as const;
    const { values, positionals } = parse(args, {
      ...flags,
      message: { type: "string", short: "m" },
    });
    const actions = (Object.keys(flags) as ReplyAction[]).filter((a) => values[a]);
    if (actions.length > 1) {
      throw new LrError(`pick one of ${actions.map((a) => `--${a}`).join(", ")}`);
    }
    const [id, ...words] = positionals;
    return reply(ctx, id, {
      action: actions[0] ?? null,
      body: values.message ?? (words.length ? words.join(" ") : null),
    });
  },
  "final show": async (ctx, args) => {
    parse(args, {});
    return finalShow(ctx);
  },
  "final message": async (ctx, args) => {
    const { values, positionals } = parse(args, FILE);
    return finalMessage(ctx, positionals[0], values.file);
  },
  "final pr-body": async (ctx, args) => finalPrBody(ctx, parse(args, FILE).values.file),
  "final cut": async (ctx, args) => {
    const { values, positionals } = parse(args, { remove: { type: "boolean" } });
    return finalCut(ctx, positionals[0], values.remove ?? false);
  },
  "final apply": async (ctx, args) => {
    parse(args, {});
    return finalApply(ctx);
  },
  rebase: async (ctx, args) => {
    const { values } = parse(args, { onto: { type: "string" } });
    return rebase(ctx, { onto: values.onto });
  },
  status: async (ctx, args) => {
    parse(args, {});
    return status(ctx);
  },
  ui: async (ctx, args) => {
    const { values } = parse(args, { port: { type: "string" }, "no-open": { type: "boolean" } });
    return ui(ctx.with({ actor: resolveHuman(values.as) }), {
      port: values.port,
      open: !values["no-open"],
      dev: process.env.LR_UI_DEV === "1",
    });
  },
};

/** Every command, as typed after `lr` (skills are tested against this list). */
export const COMMAND_NAMES = [...Object.keys(COMMANDS), "hook", "repo relink"];

const FILE = { file: { type: "string", short: "F" } } as const;

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

function parse<T extends Options>(args: string[], options: T) {
  return parseArgs({
    args,
    options: { ...GLOBAL, ...options },
    allowPositionals: true,
    strict: true,
  });
}

export async function main(argv: string[], io: Io): Promise<number> {
  // Hooks run in any directory Claude Code is in, so they find (or skip) the repo themselves.
  if (argv[0] === "hook") {
    return guarded(io, async () => {
      const { values, positionals } = parse(argv.slice(1), {});
      return hook(positionals[0], io, values.repo);
    });
  }

  // The command comes first: `lr <group> <verb> [options]` or `lr <verb> [options]`.
  const name = [argv.slice(0, 2).join(" "), argv[0] ?? ""].find((n) => n in COMMANDS);
  const wantsHelp =
    argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv[0] === "help";
  // Relinking moves lr's state for this repo into place, so it mustn't open (and create) it first.
  if (argv[0] === "repo" && argv[1] === "relink" && !wantsHelp) {
    return guarded(io, async () => {
      const { values, positionals } = parse(argv.slice(2), {});
      return repoRelink(io, positionals[0], values);
    });
  }
  if (!name || wantsHelp) {
    if (!wantsHelp) io.err(`error: unknown command: ${argv.join(" ")}\n`);
    io.out(USAGE);
    return wantsHelp ? 0 : 2;
  }
  const rest = argv.slice(name.split(" ").length);

  return guarded(io, async () => {
    const { values } = parseArgs({
      args: rest,
      options: GLOBAL,
      allowPositionals: true,
      strict: false,
    });
    const ctx = await Context.create(
      values as { repo?: string; feature?: string; as?: string; json?: boolean },
      io,
    );
    try {
      return await COMMANDS[name]!(ctx, rest);
    } finally {
      ctx.close();
    }
  });
}

/** Run a command, turning user-facing errors into a message and an exit code. */
async function guarded(io: Io, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof LrError) {
      io.err(`error: ${e.message}`);
      return e.exitCode;
    }
    if (e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS")) {
      io.err(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
