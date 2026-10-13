<script lang="ts">
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import type { Snippet } from "svelte";

  let { href, children }: { href: string; children: Snippet } = $props();
</script>

<a class="rowlink" {href} target="_blank" rel="noopener noreferrer"
  >{@render children()}<ExternalLinkIcon class="size-3.5" aria-hidden="true" /></a
>
