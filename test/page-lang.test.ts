import { describe, expect, test } from "bun:test";
import { withPageLang } from "../src/lib/server/page-lang";

describe("withPageLang", () => {
  test("fills the lang of the page template's <html>", async () => {
    const template = await Bun.file(new URL("../src/app.html", import.meta.url)).text();
    expect(withPageLang(template, "ja")).toContain('<html lang="ja"');
    expect(withPageLang(template, "ja")).not.toContain("%lang%");
  });

  test("page text that spells the placeholder is left alone", () => {
    const chunk = '<p>&lt;html lang="%lang%"</p><code>%lang%</code>';
    expect(withPageLang(chunk, "ja")).toBe(chunk);
  });
});
