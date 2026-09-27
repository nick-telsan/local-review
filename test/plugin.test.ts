import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import { COMMAND_NAMES } from "../src/cli.ts";
import { HOOK_EVENTS } from "../src/commands/hook.ts";
import { parsePlan } from "../src/plan.ts";
import { parseSubmission } from "../src/submission.ts";

// The plugin teaches agents to use lr, so its instructions are tested against the CLI they describe.
const PLUGIN = join(import.meta.dir, "..", "plugin");
const read = (path: string) => Bun.file(join(PLUGIN, path)).text();

/** Fenced code blocks in a markdown document, with their info strings. */
function fences(markdown: string): { lang: string; body: string }[] {
  return [...markdown.matchAll(/^(`{3,})(\w*)\n([\s\S]*?)^\1$/gm)].map((m) => ({
    lang: m[2]!,
    body: m[3]!,
  }));
}

describe("plugin", () => {
  test("every lr command the skills mention exists", async () => {
    const docs = await Array.fromAsync(new Glob("skills/**/*.md").scan(PLUGIN));
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      const text = await read(doc);
      const code = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
      code.push(...fences(text).map((f) => f.body));
      for (const snippet of code) {
        for (const m of snippet.matchAll(/(?:^|[\s(])lr ([a-z]+)(?: ([a-z]+))?/g)) {
          const known = COMMAND_NAMES.includes(`${m[1]} ${m[2]}`) || COMMAND_NAMES.includes(m[1]!);
          expect({ doc, command: `lr ${m[1]}`, known }).toEqual({
            doc,
            command: `lr ${m[1]}`,
            known: true,
          });
        }
      }
    }
  });

  test("the example review is a valid review", async () => {
    const [json] = fences(await read("skills/lr-review/SKILL.md")).filter((f) => f.lang === "json");
    const review = parseSubmission(JSON.parse(json!.body));
    expect(review.verdict).toBe("changes_requested");
    expect(review.comments).toHaveLength(5);
  });

  test("the example plan is a valid plan, with the documented default bookmark", async () => {
    const [md] = fences(await read("skills/lr-author/plan-format.md")).filter(
      (f) => f.lang === "md",
    );
    const { phases } = parsePlan(md!.body, "auth-refresh");
    expect(phases.map((p) => p.bookmark)).toEqual([
      "auth-refresh/1-schema-migration",
      "auth-refresh/rotation",
    ]);
  });

  test("hooks call lr hook events that exist", async () => {
    const { hooks } = JSON.parse(await read("hooks/hooks.json")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const events = Object.values(hooks).flatMap((groups) =>
      groups.flatMap((g) => g.hooks.map((h) => /exec lr hook ([a-z-]+)$/.exec(h.command)?.[1])),
    );
    expect(events.sort()).toEqual([...HOOK_EVENTS].sort());
  });

  test("the marketplace entry and the manifest agree", async () => {
    const manifest = await Bun.file(join(PLUGIN, ".claude-plugin/plugin.json")).json();
    const market = await Bun.file(join(PLUGIN, "../.claude-plugin/marketplace.json")).json();
    expect(market.plugins).toEqual([
      expect.objectContaining({ name: manifest.name, source: "./plugin" }),
    ]);
  });
});
