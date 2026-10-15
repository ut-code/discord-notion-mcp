<script lang="ts">
  import type { Snippet } from "svelte";
  import { Badge } from "$lib/components/ui/badge";
  import type { BadgeView } from "$lib/server/dashboard/badges";
  import { cn } from "$lib/utils";

  let { badge, children }: { badge: BadgeView; children?: Snippet } = $props();

  const tones: Record<BadgeView["tone"], string> = {
    outline: "border-border bg-background text-foreground",
    secondary: "border-transparent bg-secondary text-secondary-foreground",
    success: "border-ok-border bg-ok-bg text-ok-fg",
    destructive: "border-bad-border bg-bad-bg text-bad-fg",
    warn: "border-warn-border bg-warn-bg text-warn-fg",
    dark: "border-primary bg-primary text-primary-foreground",
  };
</script>

<Badge variant="outline" class={cn("h-[22px] rounded-full px-2 text-xs", tones[badge.tone])} title={badge.title}>
  {badge.label}{@render children?.()}
</Badge>
