import { getContext, setContext } from "svelte";
import { THEME_PATH } from "./paths";
import type { Theme } from "./theme";

const KEY = Symbol("theme");

/** The page's color theme, shared from the root layout (toggle, toaster). */
export class ThemeState {
  current = $state<Theme>("system");

  constructor(initial: Theme) {
    this.current = initial;
    this.stored = initial;
  }

  /** Saves run one after another, so a slow earlier request cannot overwrite a later choice. */
  private saving: Promise<void> = Promise.resolve();
  /** The theme the last finished save stored. */
  private stored: Theme;

  /** Switches the class on <html> at once and stores the cookie the server reads on the next load. */
  change(theme: Theme): Promise<void> {
    this.current = theme;
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme !== "system") root.classList.add(theme);
    this.saving = this.saving.then(() => this.save());
    return this.saving;
  }

  /** Stores the current theme; choices replaced while an earlier save ran are never sent. */
  private async save(): Promise<void> {
    const theme = this.current;
    if (theme === this.stored) return;
    const body = new FormData();
    body.set("theme", theme);
    try {
      await fetch(THEME_PATH, { method: "POST", body, redirect: "manual" });
      this.stored = theme;
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
