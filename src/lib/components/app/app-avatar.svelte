<script lang="ts">
  import * as Avatar from "$lib/components/ui/avatar";
  import { initialOf } from "$lib/initial";
  import { cn } from "$lib/utils";

  let {
    name,
    url = null,
    size = "default",
    class: className,
  }: { name: string; url?: string | null; size?: "sm" | "md" | "default" | "lg"; class?: string } = $props();

  const sizes = { sm: "size-6 text-[11px]", md: "size-7 text-xs", default: "size-8 text-xs", lg: "size-9 text-note" };
</script>

<!-- Discord avatar over an initial; a broken or missing image leaves the initial visible. -->
<Avatar.Root class={cn(sizes[size], "after:hidden", className)} aria-hidden="true">
  {#if url}
    <Avatar.Image src={url} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
  {/if}
  <Avatar.Fallback class="text-[length:inherit] font-semibold text-muted-foreground">{initialOf(name)}</Avatar.Fallback>
</Avatar.Root>
