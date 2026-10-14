<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { m } from "$lib/paraglide/messages.js";

  let { text, label }: { text: string; label: string } = $props();

  let available = $state(false);
  let copied = $state(false);
  onMount(() => {
    available = Boolean(navigator.clipboard);
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard access denied; the text stays selectable.
    }
  }
</script>

{#if available}
  <Button variant="outline" size="icon-sm" onclick={copy} aria-label={copied ? m.copy_done() : label} title={label}>
    {#if copied}<CheckIcon />{:else}<CopyIcon />{/if}
  </Button>
{/if}
