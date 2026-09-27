import { parseArgs } from "node:util";
import { featureList, featureStart } from "./commands/feature.ts";
import { handoff } from "./commands/handoff.ts";
import { planShow, planSubmit } from "./commands/plan.ts";
import { reviewCreate } from "./commands/review.ts";
import { status } from "./commands/status.ts";
import { reviewSubmit } from "./commands/submit.ts";
import { type ReplyAction, reply, threads } from "./commands/thread.ts";
import { Context, type Io } from "./context.ts";
import { LrError } from "./errors.ts";

const USAGE = `lr — local review for agentic development

Usage:
  lr feature start <slug> [--title <title>] [--base <revset>]
  lr feature list
  lr plan submit -F <file>        first plan for the feature (- for stdin)
  lr plan revise -F <file>        a revised plan after review
  lr plan show
  lr review create [--allow-failing] [--skip-checks]
  lr review submit [-F <review.json>] [--verdict approved|changes_requested] [-m <body>]
                   [--round <n>]      record a review on the latest (or given) open round
  lr handoff [--round <n>]        what the author needs to act on after a review
  lr threads [--status <s,…> | --all]
  lr reply <thread> [--addressed|--resolve|--dismiss|--reopen|--accept] [<message>]
  lr status

Global options:
  -R, --repo <path>     repository (default: current directory)
  --feature <slug>      feature to act on (default: $LR_FEATURE, or the only active one)
  --as <actor>          who is acting: human:<name> | agent:<name> (default: $LR_ACTOR, or $USER)
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
  "plan submit": async (ctx, args) => planSubmit(ctx, "submit", parse(args, FILE).values.file),
  "plan revise": async (ctx, args) => planSubmit(ctx, "revise", parse(args, FILE).values.file),
  "plan show": async (ctx, args) => {
    parse(args, {});
    return planShow(ctx);
  },
  "review create": async (ctx, args) => {
    const { values } = parse(args, {
      "allow-failing": { type: "boolean" },
      "skip-checks": { type: "boolean" },
    });
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
    const { values } = parse(args, { status: { type: "string" }, all: { type: "boolean" } });
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
  status: async (ctx, args) => {
    parse(args, {});
    return status(ctx);
  },
};

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
  // The command comes first: `lr <group> <verb> [options]` or `lr <verb> [options]`.
  const name = [argv.slice(0, 2).join(" "), argv[0] ?? ""].find((n) => n in COMMANDS);
  const wantsHelp =
    argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv[0] === "help";
  if (!name || wantsHelp) {
    if (!wantsHelp) io.err(`error: unknown command: ${argv.join(" ")}\n`);
    io.out(USAGE);
    return wantsHelp ? 0 : 2;
  }
  const rest = argv.slice(name.split(" ").length);

  let ctx: Context | undefined;
  try {
    const { values } = parseArgs({
      args: rest,
      options: GLOBAL,
      allowPositionals: true,
      strict: false,
    });
    ctx = await Context.create(
      values as { repo?: string; feature?: string; as?: string; json?: boolean },
      io,
    );
    return await COMMANDS[name]!(ctx, rest);
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
  } finally {
    ctx?.close();
  }
}
