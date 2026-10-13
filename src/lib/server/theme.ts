import { isTheme, type Theme } from "../theme";
import { safeNextPath } from "./dashboard/next-path";

export const THEME_COOKIE = "theme";
export const THEME_COOKIE_OPTIONS = { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true } as const;

export function themeFromCookie(value: string | undefined): Theme {
  return isTheme(value) ? value : "system";
}

const DOCUMENT_START = /^(\s*<!doctype html>\s*<html)\b/i;

/** Marks `<html>` in the first page chunk; "system" leaves the class to `prefers-color-scheme`. */
export function withThemeClass(html: string, theme: Theme): string {
  return theme === "system" ? html : html.replace(DOCUMENT_START, `$1 class="${theme}"`);
}

/** Form of `POST /theme`: `theme` and the page to return to (`next`, same-site paths only). */
export function parseThemeForm(form: FormData): { theme: Theme; location: string } | null {
  const theme = form.get("theme");
  const next = form.get("next");
  if (!isTheme(theme)) return null;
  return { theme, location: safeNextPath(typeof next === "string" ? next : null) };
}
