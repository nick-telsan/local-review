import { resolveActor } from "./actor.ts";
import { LrError } from "./errors.ts";
import { Jj } from "./jj.ts";
import type { Actor, Feature, PlanVersion } from "./model.ts";
import { featureDir } from "./paths.ts";
import { Store } from "./store.ts";

export interface GlobalOptions {
  repo?: string;
  feature?: string;
  as?: string;
  json?: boolean;
}

export interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

export class Context {
  private constructor(
    readonly jj: Jj,
    readonly store: Store,
    readonly actor: Actor,
    readonly json: boolean,
    readonly io: Output,
    private readonly featureFlag: string | undefined,
  ) {}

  static async create(opts: GlobalOptions, io: Output): Promise<Context> {
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

  close(): void {
    this.store.close();
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
    if (active.length === 0)
      throw new LrError("no active feature; start one with `lr feature start <slug>`");
    throw new LrError(
      `several active features (${active.map((f) => f.slug).join(", ")}); pick one with --feature or $LR_FEATURE`,
    );
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
