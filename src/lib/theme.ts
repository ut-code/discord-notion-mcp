import { isOneOf } from "./one-of";

/** Color theme stored in the `theme` cookie; "system" follows `prefers-color-scheme`. */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = { system: "システム", light: "ライト", dark: "ダーク" };

export function isTheme(value: unknown): value is Theme {
  return isOneOf(THEMES, value);
}

/** The toggle cycles システム → ライト → ダーク. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "system";
}
