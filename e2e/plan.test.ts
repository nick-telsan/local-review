import { afterAll, beforeAll, expect } from "bun:test";
import { closeBrowser, flow, openBrowser } from "./harness.ts";

beforeAll(openBrowser, 30_000);
afterAll(closeBrowser);

flow(
  "shows which of the plan's tasks the round's changes name",
  async ({ page, open, c2 }) => {
    await open("/f/feat/r/1");
    await page.getByText("1 of 2 tasks named by a change").waitFor();
    await page.getByRole("main").getByRole("link", { name: "Plan v1" }).click();
    await page.getByRole("heading", { name: "Plan v1", level: 1 }).waitFor();

    const task = (title: string) => page.getByRole("listitem").filter({ hasText: title });
    await task("Add table").getByText("✓").waitFor();
    await task("Add table")
      .getByRole("link", { name: /Add db/ })
      .waitFor();
    await task("Backfill").getByText("no change names this task").waitFor();

    // Phase 2 has no tasks, so its change names none; its chip goes to the change.
    const rotation = page.getByRole("region", { name: "Phase 2: Rotation" });
    await rotation.getByText("Changes naming no task:").waitFor();
    await rotation.getByRole("link", { name: /Rotate/ }).click();
    await page.getByRole("heading", { name: "Rotate", level: 1 }).waitFor();
    expect(page.url()).toEndWith(`/f/feat/r/1/c/${c2}`);
  },
  { messages: ["Add db\n\nPlan-Task: 1.1", "Rotate"] },
);
