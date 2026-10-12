import { onMount } from "svelte";

let hydrated = $state(false);

/**
 * Whether the page has hydrated (JavaScript runs). Server output and the first client
 * render see false, so components render no-JS fallbacks (native popovers, a scaled
 * chart) until then. Call during component initialisation.
 */
export function useHydrated(): { readonly current: boolean } {
  onMount(() => {
    hydrated = true;
  });
  return {
    get current() {
      return hydrated;
    },
  };
}
