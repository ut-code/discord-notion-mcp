<script lang="ts">
  import "../app.css";
  import { Toaster } from "$lib/components/ui/sonner";
  import { setThemeState, ThemeState } from "$lib/theme-state.svelte";
  import type { LayoutProps } from "./$types";

  let { data, children }: LayoutProps = $props();

  // The cookie only changes through the theme state itself, so the initial value is enough.
  // svelte-ignore state_referenced_locally
  const theme = setThemeState(new ThemeState(data.theme));
</script>

{@render children()}
<Toaster position="top-right" richColors={false} closeButton={false} theme={theme.current} />
