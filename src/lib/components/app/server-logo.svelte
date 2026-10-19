<script lang="ts">
  import * as Avatar from "#lib/components/ui/avatar/index.js";
  import { initialOf } from "#lib/initial.js";
  import { cn } from "#lib/utils.js";

  let { name, iconUrl = null, large = false }: { name: string; iconUrl?: string | null; large?: boolean } = $props();
</script>

<!-- Server icon over the name's initial; a missing or broken icon leaves the initial visible. -->
<Avatar.Root class={cn("logo after:hidden", large ? "logo-lg size-11 rounded-xl" : "size-8 rounded-lg")} aria-hidden="true">
  {#if iconUrl}
    <Avatar.Image src={iconUrl} alt="" class="rounded-[inherit]" decoding="async" referrerpolicy="no-referrer" />
  {/if}
  <Avatar.Fallback class="rounded-[inherit] bg-transparent font-[inherit] text-[length:inherit] text-current"
    >{initialOf(name)}</Avatar.Fallback
  >
</Avatar.Root>
