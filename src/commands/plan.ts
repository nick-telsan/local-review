import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { LrError } from "../errors.ts";
import { parsePlan } from "../plan.ts";

/** `lr plan submit` (first plan) and `lr plan revise` (every later one). */
export async function planSubmit(
  ctx: Context,
  mode: "submit" | "revise",
  file: string | undefined,
): Promise<number> {
  if (!file) throw new LrError(`usage: lr plan ${mode} -F <file>   (use - for stdin)`);
  const feature = ctx.feature();
  if (mode === "submit" && feature.currentPlanVersion !== null) {
    throw new LrError(
      `feature "${feature.slug}" already has a plan (v${feature.currentPlanVersion}); use \`lr plan revise\``,
    );
  }
  if (mode === "revise" && feature.currentPlanVersion === null) {
    throw new LrError(`feature "${feature.slug}" has no plan yet; use \`lr plan submit\``);
  }

  const text = await ctx.readInput(file);
  const { phases } = parsePlan(text, feature.slug);

  const latestRound = ctx.store.latestRound(feature.slug);
  const dir = ctx.featureDir(feature.slug);
  mkdirSync(join(dir, "plan"), { recursive: true });

  const plan = ctx.store.addPlanVersion(feature.slug, {
    phases,
    respondsToRound: mode === "revise" ? (latestRound?.n ?? null) : null,
    createdBy: ctx.actor,
  });
  await Bun.write(join(dir, plan.path), text);

  ctx.store.setFeatureStatus(feature.slug, latestRound ? "revising" : "implementing");

  ctx.print({ plan }, [
    `Plan v${plan.version} saved for ${feature.slug}: ${join(dir, plan.path)}`,
    ...phases.map(
      (p) =>
        `  ${p.id}. ${p.title}  [${p.bookmark}]${p.tasks.length ? `  (${p.tasks.length} tasks)` : ""}`,
    ),
  ]);
  return 0;
}

export async function planShow(ctx: Context): Promise<number> {
  const feature = ctx.feature();
  const plan = ctx.currentPlan(feature);
  const path = join(ctx.featureDir(feature.slug), plan.path);
  if (ctx.json) {
    ctx.print({ plan: { ...plan, path } }, "");
  } else {
    ctx.io.out(await Bun.file(path).text());
  }
  return 0;
}
