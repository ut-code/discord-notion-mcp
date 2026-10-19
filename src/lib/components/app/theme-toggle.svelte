<script lang="ts">
  import MonitorIcon from "@lucide/svelte/icons/monitor";
  import MoonIcon from "@lucide/svelte/icons/moon";
  import SunIcon from "@lucide/svelte/icons/sun";
  import { page } from "$app/state";
  import { Button } from "#lib/components/ui/button/index.js";
  import { m } from "#lib/paraglide/messages.js";
  import { THEME_PATH } from "#lib/paths.js";
  import { nextTheme, THEME_LABELS } from "#lib/theme.js";
  import { getThemeState } from "#lib/theme-state.svelte.js";

  const theme = getThemeState();
  const label = $derived(m.theme_toggle_label({ theme: THEME_LABELS[theme.current] }));
  const next = $derived(nextTheme(theme.current));

  function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    void theme.change(next);
  }
</script>

<!-- Without JavaScript the form posts and the server redirects back here. -->
<form method="post" action={THEME_PATH} {onsubmit}>
  <input type="hidden" name="theme" value={next} />
  <input type="hidden" name="next" value={page.url.pathname + page.url.search} />
  <Button type="submit" variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label={label} title={label}>
    {#if theme.current === "system"}
      <!-- What the system picks now (CSS follows it without JavaScript), marked with a small monitor.
           The corner under the monitor is cut out of the sun/moon, so any background shows through. -->
      <span class="relative size-4" aria-hidden="true">
        <SunIcon class="size-4 [clip-path:polygon(0_0,100%_0,100%_62%,62%_62%,62%_100%,0_100%)] dark:hidden" />
        <MoonIcon class="hidden size-4 [clip-path:polygon(0_0,100%_0,100%_62%,62%_62%,62%_100%,0_100%)] dark:block" />
        <MonitorIcon class="absolute -right-1 -bottom-1 size-[9px]" strokeWidth={2.6} />
      </span>
    {:else if theme.current === "light"}
      <SunIcon />
    {:else}
      <MoonIcon />
    {/if}
  </Button>
</form>
