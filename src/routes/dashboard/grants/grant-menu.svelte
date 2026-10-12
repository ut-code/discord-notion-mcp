<script lang="ts">
  import TrashIcon from "@lucide/svelte/icons/trash";
  import ConfirmDialog from "$lib/components/app/confirm-dialog.svelte";
  import RowMenu from "$lib/components/app/row-menu.svelte";
  import type { GrantTableRow } from "$lib/server/dashboard/grants";

  let { remove, index }: { remove: NonNullable<GrantTableRow["remove"]>; index: number } = $props();

  let confirming = $state(false);
  const confirmId = $derived(`grant-delete-${index}`);
</script>

<RowMenu
  id={`grant-menu-${index}`}
  label={remove.menuLabel}
  contentClass="min-w-[160px]"
  items={[{ kind: "confirm", label: "削除…", icon: TrashIcon, dialogId: confirmId, onSelect: () => (confirming = true) }]}
/>
<ConfirmDialog id={confirmId} bind:open={confirming} title={remove.confirm} action="delete" submitLabel="削除する" destructive>
  {#snippet fields()}
    <input type="hidden" name="permission" value={remove.permission} />
    <input type="hidden" name="subjectType" value={remove.subjectType} />
    <input type="hidden" name="subjectId" value={remove.subjectId} />
  {/snippet}
</ConfirmDialog>
