<script lang="ts">
  import type { HistoryTab } from "#lib/server/dashboard/history.js";
  import { m } from "#lib/paraglide/messages.js";

  /** The history's permission groups: the read tools' calls, and the Notion write history. A single tab still names what is listed. */
  let { tabs }: { tabs: HistoryTab[] } = $props();
</script>

{#if tabs.length > 0}
  <nav class="link-tabs" aria-label={m.history_tabs_label()}>
    {#each tabs as tab (tab.href)}
      <a class="link-tab" href={tab.href} aria-current={tab.active ? "page" : undefined}>{tab.label}</a>
    {/each}
  </nav>
{/if}
