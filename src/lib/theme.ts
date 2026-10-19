import { isOneOf } from "./one-of";
import { m } from "./paraglide/messages.js";

/** Color theme stored in the `theme` cookie; "system" follows `prefers-color-scheme`. */
const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = { system: m.theme_system(), light: m.theme_light(), dark: m.theme_dark() };

export function isTheme(value: unknown): value is Theme {
  return isOneOf(THEMES, value);
}

/** The toggle cycles system → light → dark. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "system";
}
