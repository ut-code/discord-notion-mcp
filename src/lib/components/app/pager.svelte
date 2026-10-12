<script lang="ts">
  import { Button } from "$lib/components/ui/button";

  let { prev, next }: { prev: string | null; next: string | null } = $props();
</script>

<!-- 前へ / 次へ; an end is rendered disabled. -->
<nav class="ml-auto flex gap-2" aria-label="ページ送り">
  <Button variant="outline" size="sm" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" href={prev ?? "#"} disabled={!prev} rel="prev">前へ</Button>
  <Button variant="outline" size="sm" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" href={next ?? "#"} disabled={!next} rel="next">次へ</Button>
</nav>
