import { describe, expect, test } from "bun:test";
import { parseThemeForm, themeFromCookie, THEME_COOKIE_OPTIONS, withThemeClass } from "../src/lib/server/theme";
import { nextTheme } from "../src/lib/theme";

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

describe("theme cookie → <html> class", () => {
  test("unknown or missing cookie values fall back to the system preference", () => {
    expect(themeFromCookie("dark")).toBe("dark");
    expect(themeFromCookie("light")).toBe("light");
    expect(themeFromCookie("system")).toBe("system");
    expect(themeFromCookie("pink")).toBe("system");
    expect(themeFromCookie(undefined)).toBe("system");
  });

  test("marks <html> in the page template; system adds nothing", async () => {
    const template = await Bun.file(new URL("../src/app.html", import.meta.url)).text();
    expect(withThemeClass(template, "dark")).toContain('<html lang="ja" class="dark">');
    expect(withThemeClass(template, "light")).toContain('<html lang="ja" class="light">');
    expect(withThemeClass(template, "system")).toContain('<html lang="ja">');
    expect(withThemeClass(template, "system")).not.toContain("%theme%");
  });

  test("page text that spells the placeholder is left alone", () => {
    const page = '<!doctype html><html lang="ja" class="%theme%"><body><p> class="%theme%"</p></body></html>';
    expect(withThemeClass(page, "dark")).toBe('<!doctype html><html lang="ja" class="dark"><body><p> class="%theme%"</p></body></html>');
  });

  test("the toggle cycles system → light → dark", () => {
    expect([nextTheme("system"), nextTheme("light"), nextTheme("dark")]).toEqual(["light", "dark", "system"]);
  });
});

describe("POST /theme", () => {
  test("accepts the three themes and returns to a same-site path", () => {
    expect(parseThemeForm(form({ theme: "dark", next: "/dashboard?range=7" }))).toEqual({
      theme: "dark",
      location: "/dashboard?range=7",
    });
    expect(parseThemeForm(form({ theme: "system" }))).toEqual({ theme: "system", location: "/dashboard" });
  });

  test("rejects unknown themes", () => {
    expect(parseThemeForm(form({ theme: "pink", next: "/dashboard" }))).toBeNull();
    expect(parseThemeForm(form({}))).toBeNull();
  });

  test("never redirects off-site", () => {
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "/\t/evil.example"]) {
      expect(parseThemeForm(form({ theme: "light", next }))?.location).toBe("/dashboard");
    }
  });

  test("the cookie lasts a year for the whole site", () => {
    expect(THEME_COOKIE_OPTIONS).toMatchObject({ path: "/", maxAge: 31_536_000, sameSite: "lax" });
  });
});
