<script lang="ts">
  import TrashIcon from "@lucide/svelte/icons/trash";
  import ConfirmDialog from "$lib/components/app/confirm-dialog.svelte";
  import RowMenu from "$lib/components/app/row-menu.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import type { GrantTableRow } from "$lib/server/dashboard/grants";

  let { remove, index }: { remove: NonNullable<GrantTableRow["remove"]>; index: number } = $props();

  let confirming = $state(false);
  const confirmId = $derived(`grant-delete-${index}`);
</script>

<RowMenu
  id={`grant-menu-${index}`}
  label={remove.menuLabel}
  contentClass="min-w-[160px]"
  items={[
    { kind: "confirm", label: m.grants_remove_menu_item(), icon: TrashIcon, dialogId: confirmId, onSelect: () => (confirming = true) },
  ]}
/>
<ConfirmDialog
  id={confirmId}
  bind:open={confirming}
  title={remove.confirm}
  action="delete"
  submitLabel={m.grants_remove_submit()}
  destructive
>
  {#snippet fields()}
    <input type="hidden" name="permission" value={remove.permission} />
    <input type="hidden" name="subjectType" value={remove.subjectType} />
    <input type="hidden" name="subjectId" value={remove.subjectId} />
  {/snippet}
</ConfirmDialog>
