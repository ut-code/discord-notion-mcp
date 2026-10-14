<script lang="ts">
  import MonitorIcon from "@lucide/svelte/icons/monitor";
  import MoonIcon from "@lucide/svelte/icons/moon";
  import SunIcon from "@lucide/svelte/icons/sun";
  import { page } from "$app/state";
  import { Button } from "$lib/components/ui/button";
  import { m } from "$lib/paraglide/messages.js";
  import { THEME_PATH } from "$lib/paths";
  import { nextTheme, THEME_LABELS } from "$lib/theme";
  import { getThemeState } from "$lib/theme-state.svelte";

  const theme = getThemeState();
  const icons = { system: MonitorIcon, light: SunIcon, dark: MoonIcon };
  const Icon = $derived(icons[theme.current]);
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
    <Icon />
  </Button>
</form>
