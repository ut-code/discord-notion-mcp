<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, description, action }: { title: string; description?: string; action?: Snippet } = $props();
</script>

<svelte:head>
  <title>{title} — MCP</title>
</svelte:head>

<header class="page-head">
  <div class="stack gap-1.5">
    <h1>{title}</h1>
    {#if description}<p class="text-note text-muted-foreground">{description}</p>{/if}
  </div>
  {@render action?.()}
</header>
