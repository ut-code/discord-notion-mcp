import { describe, expect, test } from "bun:test";
import { isCrossOriginWrite } from "../src/lib/server/http";
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
    expect(withThemeClass(template, "dark")).toContain('<html class="dark" lang="ja">');
    expect(withThemeClass(template, "light")).toContain('<html class="light" lang="ja">');
    expect(withThemeClass(template, "system")).toBe(template);
  });

  test("only touches the start of the document, not later chunks", () => {
    const chunk = '<pre>&lt;html&gt;</pre><script>"<!doctype html><html>"</script>';
    expect(withThemeClass(chunk, "dark")).toBe(chunk);
  });

  test("the toggle cycles system → light → dark", () => {
    expect([nextTheme("system"), nextTheme("light"), nextTheme("dark")]).toEqual(["light", "dark", "system"]);
  });
});

describe("POST /theme", () => {
  test("accepts the three themes and returns to a same-site path", () => {
    expect(parseThemeForm(form({ theme: "dark", next: "/dashboard/stats?range=7" }))).toEqual({
      theme: "dark",
      location: "/dashboard/stats?range=7",
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

  test("cross-origin posts are refused by the hook's origin check", () => {
    const post = (origin: string) => new Request("https://mcp.example.com/theme", { method: "POST", headers: { origin } });
    expect(isCrossOriginWrite(post("https://evil.example"), "https://mcp.example.com")).toBe(true);
    expect(isCrossOriginWrite(post("https://mcp.example.com"), "https://mcp.example.com")).toBe(false);
  });

  test("the cookie lasts a year for the whole site", () => {
    expect(THEME_COOKIE_OPTIONS).toMatchObject({ path: "/", maxAge: 31_536_000, sameSite: "lax" });
  });
});
