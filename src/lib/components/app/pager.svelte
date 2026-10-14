<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { m } from "$lib/paraglide/messages.js";

  let { prev, next }: { prev: string | null; next: string | null } = $props();
</script>

<!-- Previous / next; hidden on a single page, an end is rendered disabled. -->
{#if prev || next}
  <nav class="ml-auto flex gap-2" aria-label={m.pager_label()}>
    <Button
      variant="outline"
      size="sm"
      class="aria-disabled:pointer-events-none aria-disabled:opacity-50"
      href={prev ?? "#"}
      disabled={!prev}
      rel="prev">{m.pager_prev()}</Button
    >
    <Button
      variant="outline"
      size="sm"
      class="aria-disabled:pointer-events-none aria-disabled:opacity-50"
      href={next ?? "#"}
      disabled={!next}
      rel="next">{m.pager_next()}</Button
    >
  </nav>
{/if}
