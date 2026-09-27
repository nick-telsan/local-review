import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export async function featureStart(
  ctx: Context,
  slug: string | undefined,
  opts: { title?: string; base?: string },
): Promise<number> {
  if (!slug || !SLUG.test(slug)) {
    throw new LrError(
      "usage: lr feature start <slug> [--title <title>] [--base <revset>]\n" +
        "slug: lowercase letters, digits, and dashes",
    );
  }
  const baseRevset = opts.base ?? "trunk()";
  // Fail early on a revset that doesn't resolve.
  await ctx.jj.run(["log", "--no-graph", "--limit", "1", "-r", baseRevset, "-T", "commit_id"]);

  const feature = ctx.store.createFeature({ slug, title: opts.title ?? slug, baseRevset });
  ctx.print({ feature, dir: ctx.featureDir(slug) }, [
    `Started feature ${slug} (base: ${baseRevset})`,
    `State: ${ctx.featureDir(slug)}`,
    `Next: write a plan and run \`lr plan submit -F <file>\``,
  ]);
  return 0;
}

export async function featureList(ctx: Context): Promise<number> {
  const features = ctx.store.listFeatures();
  ctx.print(
    { features },
    features.length === 0
      ? "No features yet."
      : features.map(
          (f) =>
            `${f.slug.padEnd(24)} ${f.status.padEnd(13)} plan v${f.currentPlanVersion ?? "-"}  ${f.title}`,
        ),
  );
  return 0;
}
