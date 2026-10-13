import { getContext, setContext } from "svelte";
import { THEME_PATH } from "./paths";
import type { Theme } from "./theme";

const KEY = Symbol("theme");

/** The page's color theme, shared from the root layout (toggle, toaster). */
export class ThemeState {
  current = $state<Theme>("system");

  constructor(initial: Theme) {
    this.current = initial;
  }

  /** Switches the class on <html> at once and stores the cookie the server reads on the next load. */
  async change(theme: Theme): Promise<void> {
    this.current = theme;
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme !== "system") root.classList.add(theme);
    const body = new FormData();
    body.set("theme", theme);
    try {
      await fetch(THEME_PATH, { method: "POST", body, redirect: "manual" });
    } catch (error) {
      console.error(error);
    }
  }
}

export function setThemeState(state: ThemeState): ThemeState {
  return setContext(KEY, state);
}

export function getThemeState(): ThemeState {
  return getContext<ThemeState>(KEY);
}
