<script lang="ts">
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { actionUrl } from "#lib/action-url.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as NativeSelect from "#lib/components/ui/native-select/index.js";
  import { grantSubmitLabel } from "#lib/grant-label.js";
  import { useHydrated } from "#lib/hydrated.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { GrantFormView } from "#lib/server/dashboard/grants.js";
  import SubjectList from "./subject-list.svelte";

  let { form, filter }: { form: GrantFormView; filter: string | null } = $props();

  const hydrated = useHydrated();

  // Form state follows the server data (e.g. after a search without JavaScript) and the user's choices.
  let permission = $derived(form.permission);
  let chosen = $derived(form.selected);

  const permissionOption = $derived(
    form.permissions.find((option) => option.value === permission) ??
      form.permissions[0] ?? { value: permission, label: permission, hint: "" },
  );
  const submitLabel = $derived(grantSubmitLabel(permissionOption.label, chosen?.label ?? null));
  // Shown before granting: an exact repeat cannot be submitted; a permission the subject
  // gets some other way can, with the reason it adds nothing.
  const alreadyGranted = $derived(chosen?.granted.includes(permission) ?? false);
  const notice = $derived(alreadyGranted ? m.grants_notice_granted() : chosen?.notices[permission]);
</script>

<section class="panel panel-pad col-side gap-[18px]" aria-labelledby="add-grant">
  <h2 id="add-grant">{m.grants_add()}</h2>
  <form class="flex flex-col gap-[18px]" method="post" action={actionUrl(page.url, "create")} use:enhance>
    {#if filter}<input type="hidden" name="filter" value={filter} />{/if}
    <div class="flex flex-col gap-2">
      <Label for="grant-permission">{m.common_permission()}</Label>
      <NativeSelect.Root id="grant-permission" name="permission" class="w-full" aria-describedby="grant-hint" bind:value={permission}>
        {#each form.permissions as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </NativeSelect.Root>
      <span class="text-xs text-muted-foreground" id="grant-hint">{permissionOption.hint}</span>
    </div>

    <SubjectList id="grant-subject" {form} bind:chosen />

    {#if notice}
      <p class="flex items-start gap-1.5 text-note text-warn-text" role="status">
        <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />{notice}
      </p>
    {/if}
    <!-- Without JavaScript the choice is not tracked here, so the server checks it instead. -->
    <Button type="submit" class="w-full" disabled={hydrated.current && (!chosen || alreadyGranted)}>{submitLabel}</Button>
  </form>
</section>
