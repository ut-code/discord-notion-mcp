<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, action }: { title: string; action?: Snippet } = $props();
</script>

<svelte:head>
  <title>{title} — MCP</title>
</svelte:head>

<header class="page-head">
  <h1>{title}</h1>
  {@render action?.()}
</header>
