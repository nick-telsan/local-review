import { resolveActor } from "./actor.ts";
import { LrError } from "./errors.ts";
import { readInput } from "./io.ts";
import { Jj } from "./jj.ts";
import type { Actor, Feature, PlanVersion, Round } from "./model.ts";
import { featureDir, movedHint } from "./paths.ts";
import { Store } from "./store.ts";

export interface GlobalOptions {
  repo?: string;
  feature?: string;
  as?: string;
  json?: boolean;
}

/** All process I/O, injected at the entry point so tests can supply their own. */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  stdin: () => Promise<string>;
}

export class Context {
  private constructor(
    readonly jj: Jj,
    readonly store: Store,
    readonly actor: Actor,
    readonly json: boolean,
    readonly io: Io,
    private readonly featureFlag: string | undefined,
  ) {}

  static async create(opts: GlobalOptions, io: Io): Promise<Context> {
    const jj = await Jj.discover(opts.repo ?? process.cwd());
    const store = await Store.open(jj.root);
    return new Context(
      jj,
      store,
      resolveActor(opts.as),
      opts.json ?? false,
      io,
      opts.feature ?? process.env.LR_FEATURE,
    );
  }

  /** The same repo and store, with some settings changed (e.g. the UI server's per-request contexts). */
  with(opts: { actor?: Actor; json?: boolean; io?: Io; feature?: string }): Context {
    return new Context(
      this.jj,
      this.store,
      opts.actor ?? this.actor,
      opts.json ?? this.json,
      opts.io ?? this.io,
      opts.feature ?? this.featureFlag,
    );
  }

  close(): void {
    this.store.close();
  }

  /** Read a file argument; `-` means stdin. */
  readInput(path: string): Promise<string> {
    return readInput(path, this.io.stdin);
  }

  featureDir(slug: string): string {
    return featureDir(this.jj.root, slug);
  }

  /** --feature / $LR_FEATURE, else the only active feature in this repo. */
  feature(): Feature {
    if (this.featureFlag) {
      const f = this.store.getFeature(this.featureFlag);
      if (!f) throw new LrError(`no feature "${this.featureFlag}" in this repo`);
      return f;
    }
    const active = this.store
      .listFeatures()
      .filter((f) => f.status !== "done" && f.status !== "abandoned");
    if (active.length === 1) return active[0]!;
    if (active.length === 0) {
      const finished = this.store.listFeatures().map((f) => `${f.slug} (${f.status})`);
      throw new LrError(
        "no active feature; start one with `lr feature start <slug>`" +
          (finished.length
            ? `, or pick a finished one with --feature: ${finished.join(", ")}`
            : movedHint(this.jj.root)),
      );
    }
    throw new LrError(
      `several active features (${active.map((f) => f.slug).join(", ")}); pick one with --feature or $LR_FEATURE`,
    );
  }

  /** Round `requested` (a CLI argument), or the latest round. */
  round(feature: Feature, requested?: string): Round {
    const latest = this.store.latestRound(feature.slug);
    if (!latest) throw new LrError("no review round yet; open one with `lr review create`");
    if (requested === undefined) return latest;
    const n = Number(requested);
    const found = Number.isInteger(n) ? this.store.getRound(feature.slug, n) : null;
    if (!found) throw new LrError(`no round ${requested} (latest is ${latest.n})`);
    return found;
  }

  currentPlan(feature: Feature): PlanVersion {
    if (feature.currentPlanVersion === null) {
      throw new LrError(
        `feature "${feature.slug}" has no plan yet; submit one with \`lr plan submit -F <file>\``,
      );
    }
    return this.store.getPlanVersion(feature.slug, feature.currentPlanVersion)!;
  }

  /** Print JSON in --json mode, otherwise the text lines. */
  print(json: unknown, text: string | string[]): void {
    if (this.json) this.io.out(JSON.stringify(json, null, 2));
    else this.io.out(Array.isArray(text) ? text.join("\n") : text);
  }
}
