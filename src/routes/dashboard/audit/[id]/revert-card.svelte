<script lang="ts">
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import Undo2Icon from "@lucide/svelte/icons/undo-2";
  import { onMount } from "svelte";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { actionUrl } from "$lib/action-url";
  import ToneBadge from "$lib/components/app/tone-badge.svelte";
  import * as Alert from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import type { RevertView } from "$lib/server/admin/audit";

  let { revert, conflict, targetUrl }: { revert: RevertView; conflict: boolean; targetUrl: string | null } = $props();

  // Before hydration (or without JavaScript) the confirmation is a native popover.
  let hydrated = $state(false);
  let confirming = $state(false);
  onMount(() => {
    hydrated = true;
  });

  const action = $derived(actionUrl(page.url, "revert"));
</script>

<aside class="col-side" aria-labelledby="revert-heading">
  <section class="panel panel-pad">
    <h2 id="revert-heading">この変更を取り消す</h2>
    {#if revert.state === "reverted"}
      <div class="stack gap-2">
        <span class="cluster">
          <ToneBadge badge={{ label: "取り消し済み", tone: "secondary" }} />
          {#if revert.revert}<a href={revert.revert.href}>#{revert.revert.id}</a>{/if}
        </span>
        {#if revert.note}<span class="sub">{revert.note}</span>{/if}
      </div>
    {:else if revert.state === "disabled"}
      <p class="text-muted-foreground">NOTION_TOKEN が未設定のため取り消せません。</p>
    {:else if conflict}
      <form method="post" {action} class="stack gap-4" use:enhance>
        <input type="hidden" name="force" value="true" />
        <Alert.Root class="border-warn-border bg-warn-bg rounded-[10px] p-3.5 *:[svg]:text-warn-icon">
          <TriangleAlertIcon />
          <Alert.Title class="text-warn-text font-semibold">この変更の後にページが編集されています</Alert.Title>
          <Alert.Description class="text-warn-fg text-[13px] leading-relaxed">
            取り消すと、後からの編集と食い違う可能性があります。内容を確認してから実行してください。
          </Alert.Description>
        </Alert.Root>
        <label class="flex cursor-pointer items-start gap-2.5 text-sm">
          <input type="checkbox" name="confirm" value="yes" required class="accent-primary mt-0.5 size-4 shrink-0" />
          <span>後からの編集を確認した上で取り消す</span>
        </label>
        <div class="stack gap-2">
          <Button type="submit" class="bg-bad-strong hover:bg-bad-fg w-full text-white">
            <Undo2Icon />
            強制的に取り消す
          </Button>
          {#if targetUrl}
            <Button variant="outline" class="w-full" href={targetUrl} target="_blank" rel="noopener noreferrer">Notion でページを確認</Button>
          {/if}
        </div>
      </form>
    {:else if hydrated}
      <Button variant="outline" class="w-full" onclick={() => (confirming = true)}>
        <Undo2Icon />
        取り消す
      </Button>
      <AlertDialog.Root bind:open={confirming}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>この変更を取り消しますか？</AlertDialog.Title>
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
            <input type="hidden" name="confirm" value="yes" />
            <AlertDialog.Footer>
              <AlertDialog.Cancel type="button">キャンセル</AlertDialog.Cancel>
              <Button type="submit">取り消す</Button>
            </AlertDialog.Footer>
          </form>
        </AlertDialog.Content>
      </AlertDialog.Root>
    {:else}
      <Button variant="outline" class="w-full" popovertarget="revert-confirm">
        <Undo2Icon />
        取り消す
      </Button>
      <div class="native-dialog" id="revert-confirm" popover="auto" role="dialog" aria-labelledby="revert-confirm-title">
        <p class="text-base font-semibold" id="revert-confirm-title">この変更を取り消しますか？</p>
        <form method="post" {action} class="mt-4 flex justify-end gap-2">
          <input type="hidden" name="confirm" value="yes" />
          <Button variant="outline" popovertarget="revert-confirm" popovertargetaction="hide">キャンセル</Button>
          <Button type="submit">取り消す</Button>
        </form>
      </div>
    {/if}
  </section>
</aside>
