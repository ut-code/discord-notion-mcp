<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, wide = false, children }: { title: string; wide?: boolean; children: Snippet } = $props();
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<!-- Centered single column used by sign-in, consent and message pages. -->
<main class="auth">
  <div class={wide ? "auth-col auth-col-wide" : "auth-col"}>
    {@render children()}
  </div>
</main>
