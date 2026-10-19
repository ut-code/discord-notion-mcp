<script lang="ts">
  import BanIcon from "@lucide/svelte/icons/ban";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import ConfirmDialog from "#lib/components/app/confirm-dialog.svelte";
  import RowMenu, { type RowMenuItem } from "#lib/components/app/row-menu.svelte";
  import { m } from "#lib/paraglide/messages.js";
  import type { UserTableRow } from "#lib/server/dashboard/users.js";

  let { row, index, canRevoke }: { row: UserTableRow; index: number; canRevoke: boolean } = $props();

  let confirming = $state(false);
  const confirmId = $derived(`user-revoke-${index}`);
  const hasLinks = $derived(row.grantHref !== null || row.auditHref !== null);
  const items = $derived.by(() => {
    const entries: RowMenuItem[] = [];
    if (row.grantHref) entries.push({ kind: "link", label: m.grants_add(), href: row.grantHref, icon: ShieldIcon });
    if (row.auditHref) entries.push({ kind: "link", label: m.users_menu_audit(), href: row.auditHref, icon: HistoryIcon });
    if (canRevoke) {
      if (hasLinks) entries.push({ kind: "separator" });
      entries.push({
        kind: "confirm",
        label: m.users_menu_revoke(),
        icon: BanIcon,
        dialogId: confirmId,
        onSelect: () => (confirming = true),
      });
    }
    return entries;
  });
</script>

<!-- Nothing to render when the viewer can do nothing with the row. -->
{#if items.length > 0}
  <RowMenu id={`user-menu-${index}`} label={m.users_menu_label({ name: row.displayName })} contentClass="min-w-[200px]" {items} />
{/if}
{#if canRevoke}
  <ConfirmDialog
    id={confirmId}
    bind:open={confirming}
    title={m.users_revoke_confirm({ name: row.displayName })}
    description={m.users_revoke_description()}
    action="revoke"
    submitLabel={m.users_revoke_submit()}
    destructive
  >
    {#snippet fields()}
      <input type="hidden" name="userId" value={row.userId} />
    {/snippet}
  </ConfirmDialog>
{/if}
