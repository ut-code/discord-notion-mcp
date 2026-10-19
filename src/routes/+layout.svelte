<script lang="ts">
  import "../app.css";
  import { Toaster } from "#lib/components/ui/sonner/index.js";
  import { setThemeState, ThemeState } from "#lib/theme-state.svelte.js";
  import type { LayoutProps } from "./$types";

  let { data, children }: LayoutProps = $props();

  // The cookie only changes through the theme state itself, so the initial value is enough.
  // svelte-ignore state_referenced_locally
  const theme = setThemeState(new ThemeState(data.theme));
</script>

{@render children()}
<Toaster position="top-right" richColors={false} closeButton={false} theme={theme.current} />
