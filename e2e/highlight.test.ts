import { afterAll, beforeAll, expect } from "bun:test";
import type { Locator } from "playwright-core";
import { closeBrowser, expectTexts, flow, openBrowser, until } from "./harness.ts";

beforeAll(openBrowser, 30_000);
afterAll(closeBrowser);

/** The color of the code in `line` that holds `text`: its token's, or the line's when it's plain. */
const colorOf = (line: Locator, text: string) =>
  line.evaluate((cell, text) => {
    const token = [...cell.querySelectorAll("span")].find((s) => s.textContent?.includes(text));
    return getComputedStyle(token ?? cell).color;
  }, text);

const plainColor = (line: Locator) => line.evaluate((cell) => getComputedStyle(cell).color);

flow(
  "highlights a diff's code by its file's type, in light and dark",
  async ({ page, open, c1 }) => {
    await open(`/f/feat/r/1/c/${c1}`);
    const code = page.getByRole("region", { name: "app.ts" }).getByTestId("line-text");
    await expectTexts(code, ["+/* A comment", "+   over lines */", '+const s = "x";']);
    const [first, second, last] = [code.nth(0), code.nth(1), code.nth(2)];
    await until("app.ts is highlighted", async () => {
      return (await colorOf(last, "const")) !== (await plainColor(last));
    });

    // The comment's second line is a comment too: the hunk is highlighted as a whole.
    const comment = await colorOf(first, "A comment");
    expect(await colorOf(second, "over lines")).toBe(comment);
    const keyword = await colorOf(last, "const");
    expect(keyword).not.toBe(comment);
    expect(await colorOf(last, '"x"')).not.toBe(keyword);

    // A file of an unknown type stays plain.
    const notes = page.getByRole("region", { name: "notes.xyz" }).getByTestId("line-text");
    await expectTexts(notes, ["+some notes"]);
    expect(await colorOf(notes, "some notes")).toBe(await plainColor(notes));

    await page.emulateMedia({ colorScheme: "dark" });
    await until("the colors are dark mode's", async () => {
      return (await colorOf(last, "const")) !== keyword;
    });
    expect(await colorOf(second, "over lines")).toBe(await colorOf(first, "A comment"));
    expect(await colorOf(second, "over lines")).not.toBe(comment);
  },
  {
    files: [
      {
        "app.ts": '/* A comment\n   over lines */\nconst s = "x";\n',
        "notes.xyz": "some notes\n",
      },
      { "rotate.ts": "r1\nr2\n" },
    ],
  },
);
