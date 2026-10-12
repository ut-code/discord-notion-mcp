<script lang="ts">
  import type { BadgeView } from "$lib/server/dashboard/badges";
  import ToneBadge from "./tone-badge.svelte";

  let { badges }: { badges: BadgeView[] } = $props();
</script>

<span class="cluster">
  {#each badges as badge (badge.label)}
    <ToneBadge {badge} />
  {/each}
</span>
