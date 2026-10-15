<script lang="ts" module>
  import type { Component } from "svelte";

  export type RowMenuItem =
    | { kind: "link"; label: string; href: string; icon: Component }
    | { kind: "separator" }
    /** Destructive; opens a confirm dialog (`dialogId` is its native popover before hydration). */
    | { kind: "confirm"; label: string; icon: Component; dialogId: string; onSelect: () => void };
</script>

<script lang="ts">
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { useHydrated } from "$lib/hydrated.svelte";

  let {
    id,
    label,
    contentClass,
    items,
  }: {
    /** Id of the native popover menu that stands in before hydration. */
    id: string;
    /** Accessible name of the trigger. */
    label: string;
    contentClass?: string;
    items: RowMenuItem[];
  } = $props();

  const hydrated = useHydrated();
</script>

{#if hydrated.current}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label={label}>
          <EllipsisIcon />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class={contentClass}>
      {#each items as item, index (index)}
        {#if item.kind === "link"}
          {@const Icon = item.icon}
          <DropdownMenu.Item>
            {#snippet child({ props })}
              <a {...props} href={item.href}><Icon />{item.label}</a>
            {/snippet}
          </DropdownMenu.Item>
        {:else if item.kind === "separator"}
          <DropdownMenu.Separator />
        {:else}
          {@const Icon = item.icon}
          <DropdownMenu.Item variant="destructive" onSelect={item.onSelect}>
            <Icon />{item.label}
          </DropdownMenu.Item>
        {/if}
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  <Button variant="ghost" size="icon-sm" class="text-muted-foreground" popovertarget={id} aria-label={label} style={`anchor-name:--${id}`}>
    <EllipsisIcon />
  </Button>
  <div class="native-menu" {id} popover="auto" style={`position-anchor:--${id}`}>
    {#each items as item, index (index)}
      {#if item.kind === "link"}
        {@const Icon = item.icon}
        <a class="native-menu-item" href={item.href}><Icon class="size-4" />{item.label}</a>
      {:else if item.kind === "separator"}
        <div class="my-1 h-px bg-border" role="separator"></div>
      {:else}
        {@const Icon = item.icon}
        <button class="native-menu-item danger" type="button" popovertarget={item.dialogId}><Icon class="size-4" />{item.label}</button>
      {/if}
    {/each}
  </div>
{/if}
