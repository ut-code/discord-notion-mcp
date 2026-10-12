<script lang="ts">
  import BanIcon from "@lucide/svelte/icons/ban";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import { onMount } from "svelte";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { actionUrl } from "$lib/action-url";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import type { UserTableRow } from "$lib/server/admin/users";

  let { row, index, canRevoke }: { row: UserTableRow; index: number; canRevoke: boolean } = $props();

  // Before hydration (or without JavaScript) the menu and confirmation are native popovers.
  let hydrated = $state(false);
  let confirming = $state(false);
  onMount(() => {
    hydrated = true;
  });

  const menuId = $derived(`user-menu-${index}`);
  const confirmId = $derived(`user-revoke-${index}`);
  const action = $derived(actionUrl(page.url, "revoke"));
  const confirmTitle = $derived(`${row.displayName} のトークンを失効しますか？`);
  const hasLinks = $derived(row.grantHref !== null || row.auditHref !== null);
  const destructive = "bg-bad-strong hover:bg-bad-fg text-white";
</script>

{#if !hasLinks && !canRevoke}
  <!-- Nothing this viewer can do with the row. -->
{:else if hydrated}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon-sm" class="text-text-4" aria-label={`${row.displayName} の操作`}>
          <EllipsisIcon />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="min-w-[200px]">
      {#if row.grantHref}
        <DropdownMenu.Item>
          {#snippet child({ props })}
            <a {...props} href={row.grantHref}><ShieldIcon />権限を付与</a>
          {/snippet}
        </DropdownMenu.Item>
      {/if}
      {#if row.auditHref}
        <DropdownMenu.Item>
          {#snippet child({ props })}
            <a {...props} href={row.auditHref}><HistoryIcon />書き込み履歴を見る</a>
          {/snippet}
        </DropdownMenu.Item>
      {/if}
      {#if canRevoke}
        {#if hasLinks}<DropdownMenu.Separator />{/if}
        <DropdownMenu.Item variant="destructive" onSelect={() => (confirming = true)}>
          <BanIcon />トークンを失効…
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  {#if canRevoke}
    <AlertDialog.Root bind:open={confirming}>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{confirmTitle}</AlertDialog.Title>
          <AlertDialog.Description>MCP の接続が即座に切れます。</AlertDialog.Description>
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
          <input type="hidden" name="userId" value={row.userId} />
          <AlertDialog.Footer>
            <AlertDialog.Cancel type="button">キャンセル</AlertDialog.Cancel>
            <Button type="submit" class={destructive}>失効する</Button>
          </AlertDialog.Footer>
        </form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  {/if}
{:else}
  <Button
    variant="ghost"
    size="icon-sm"
    class="text-text-4"
    popovertarget={menuId}
    aria-label={`${row.displayName} の操作`}
    style={`anchor-name:--${menuId}`}
  >
    <EllipsisIcon />
  </Button>
  <div class="native-menu" id={menuId} popover="auto" style={`position-anchor:--${menuId}`}>
    {#if row.grantHref}<a class="native-menu-item" href={row.grantHref}><ShieldIcon class="size-4" />権限を付与</a>{/if}
    {#if row.auditHref}<a class="native-menu-item" href={row.auditHref}><HistoryIcon class="size-4" />書き込み履歴を見る</a>{/if}
    {#if canRevoke}
      {#if hasLinks}<div class="bg-border my-1 h-px" role="separator"></div>{/if}
      <button class="native-menu-item danger" type="button" popovertarget={confirmId}><BanIcon class="size-4" />トークンを失効…</button>
    {/if}
  </div>
  {#if canRevoke}
    <div class="native-dialog" id={confirmId} popover="auto" role="dialog" aria-labelledby={`${confirmId}-title`}>
      <p class="text-base font-semibold" id={`${confirmId}-title`}>{confirmTitle}</p>
      <p class="text-muted-foreground text-sm">MCP の接続が即座に切れます。</p>
      <form method="post" {action} class="mt-4 flex justify-end gap-2">
        <input type="hidden" name="userId" value={row.userId} />
        <Button variant="outline" popovertarget={confirmId} popovertargetaction="hide">キャンセル</Button>
        <Button type="submit" class={destructive}>失効する</Button>
      </form>
    </div>
  {/if}
{/if}
