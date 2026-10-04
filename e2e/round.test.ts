import { afterAll, beforeAll, expect } from "bun:test";
import { closeBrowser, expectTexts, flow, openBrowser } from "./harness.ts";

beforeAll(openBrowser, 30_000);
afterAll(closeBrowser);

flow("opens a round from the feature list, then a change and its diff", async ({ page, open }) => {
  await open();
  await page.getByRole("heading", { name: "Active" }).waitFor();
  await page.getByRole("link", { name: /^feat/ }).click();

  await page.getByRole("heading", { name: "feat", level: 1 }).waitFor();
  await page.getByText("Round 1 · open").waitFor();
  const stack = page.getByRole("navigation", { name: "Stack" });
  await stack.getByRole("link", { name: /Rotate/ }).waitFor();
  await stack.getByRole("link", { name: /Add db/ }).click();

  await page.getByRole("heading", { name: "Add db", level: 1 }).waitFor();
  expect(page.url()).toMatch(/\/f\/feat\/r\/1\/c\/[a-z]+$/);
  const file = page.getByRole("region", { name: "db.ts" });
  await file.getByRole("button", { name: "New line 3" }).waitFor();
  expect(await file.getByRole("button", { name: /^Old line/ }).count()).toBe(0);
  await expectTexts(file.getByTestId("line-text"), ["+a", "+b", "+c"]);
});
