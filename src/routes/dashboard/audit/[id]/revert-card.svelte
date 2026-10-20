<script lang="ts">
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import Undo2Icon from "@lucide/svelte/icons/undo-2";
  import ConfirmDialog from "#lib/components/app/confirm-dialog.svelte";
  import ToneBadge from "#lib/components/app/tone-badge.svelte";
  import * as Alert from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { useHydrated } from "#lib/hydrated.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { RevertView } from "#lib/server/dashboard/audit.js";

  let { revert, conflict, targetUrl }: { revert: RevertView; conflict: boolean; targetUrl: string | null } = $props();

  const hydrated = useHydrated();
  let confirming = $state(false);
</script>

<aside class="col-side" aria-labelledby="revert-heading">
  <section class="panel panel-pad">
    <h2 id="revert-heading">{m.revert_card_heading()}</h2>
    {#if revert.state === "reverted"}
      <div class="stack gap-2">
        <span class="cluster">
          <ToneBadge badge={{ label: m.audit_status_reverted(), tone: "secondary" }} />
          {#if revert.revert}<a href={revert.revert.href}>#{revert.revert.id}</a>{/if}
        </span>
        {#if revert.note}<span class="sub">{revert.note}</span>{/if}
      </div>
    {:else if revert.state === "disabled"}
      <p class="text-muted-foreground">{m.revert_reason_notion_disabled()}</p>
    {:else if revert.state === "unavailable"}
      <p class="text-muted-foreground">{revert.reason}</p>
    {:else if conflict}
      <div class="stack gap-4">
        <Alert.Root class="rounded-lg border-warn-border bg-warn-bg p-3.5 *:[svg]:text-warn-icon">
          <TriangleAlertIcon />
          <Alert.Title class="font-semibold text-warn-text">{m.revert_card_conflict_title()}</Alert.Title>
          <Alert.Description class="text-note leading-relaxed text-warn-fg">
            {m.revert_card_conflict_body()}
          </Alert.Description>
        </Alert.Root>
        {#if targetUrl}
          <Button variant="outline" class="w-full" href={targetUrl} target="_blank" rel="noopener noreferrer"
            >{m.revert_card_open_in_notion()}</Button
          >
        {/if}
      </div>
    {:else}
      <!-- Before hydration the button opens the dialog's native popover. -->
      <Button
        variant="outline"
        class="w-full"
        popovertarget={hydrated.current ? undefined : "revert-confirm"}
        onclick={() => (confirming = true)}
      >
        <Undo2Icon />
        {m.revert_card_revert()}
      </Button>
      <ConfirmDialog
        id="revert-confirm"
        bind:open={confirming}
        title={m.revert_card_dialog_title()}
        action="revert"
        submitLabel={m.revert_card_revert()}
      >
        {#snippet fields()}
          <input type="hidden" name="confirm" value="yes" />
        {/snippet}
      </ConfirmDialog>
    {/if}
  </section>
</aside>
