<script lang="ts">
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import TrashIcon from "@lucide/svelte/icons/trash";
  import { onMount } from "svelte";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { actionUrl } from "$lib/action-url";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import type { GrantTableRow } from "$lib/server/admin/grants";

  let { remove, index }: { remove: NonNullable<GrantTableRow["remove"]>; index: number } = $props();

  // Before hydration (or without JavaScript) the menu and confirmation are native popovers.
  let hydrated = $state(false);
  let confirming = $state(false);
  onMount(() => {
    hydrated = true;
  });

  const menuId = $derived(`grant-menu-${index}`);
  const confirmId = $derived(`grant-delete-${index}`);
  const action = $derived(actionUrl(page.url, "delete"));
  const destructive = "bg-bad-strong hover:bg-bad-fg text-white";
</script>

{#snippet fields()}
  <input type="hidden" name="permission" value={remove.permission} />
  <input type="hidden" name="subjectType" value={remove.subjectType} />
  <input type="hidden" name="subjectId" value={remove.subjectId} />
{/snippet}

{#if hydrated}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon-sm" class="text-text-4" aria-label={remove.menuLabel}>
          <EllipsisIcon />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="min-w-[160px]">
      <DropdownMenu.Item variant="destructive" onSelect={() => (confirming = true)}>
        <TrashIcon />削除…
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <AlertDialog.Root bind:open={confirming}>
    <AlertDialog.Content>
      <AlertDialog.Header>
        <AlertDialog.Title>{remove.confirm}</AlertDialog.Title>
      </AlertDialog.Header>
      <form
        method="post"
        {action}
        use:enhance={() =>
          async ({ update }) => {
            confirming = false;
            await update();
          }}
      >
        {@render fields()}
        <AlertDialog.Footer>
          <AlertDialog.Cancel type="button">キャンセル</AlertDialog.Cancel>
          <Button type="submit" class={destructive}>削除する</Button>
        </AlertDialog.Footer>
      </form>
    </AlertDialog.Content>
  </AlertDialog.Root>
{:else}
  <Button variant="ghost" size="icon-sm" class="text-text-4" popovertarget={menuId} aria-label={remove.menuLabel} style={`anchor-name:--${menuId}`}>
    <EllipsisIcon />
  </Button>
  <div class="native-menu" id={menuId} popover="auto" style={`position-anchor:--${menuId}`}>
    <button class="native-menu-item danger" type="button" popovertarget={confirmId}><TrashIcon class="size-4" />削除…</button>
  </div>
  <div class="native-dialog" id={confirmId} popover="auto" role="dialog" aria-labelledby={`${confirmId}-title`}>
    <p class="text-base font-semibold" id={`${confirmId}-title`}>{remove.confirm}</p>
    <form method="post" {action} class="mt-4 flex justify-end gap-2">
      {@render fields()}
      <Button variant="outline" popovertarget={confirmId} popovertargetaction="hide">キャンセル</Button>
      <Button type="submit" class={destructive}>削除する</Button>
    </form>
  </div>
{/if}
