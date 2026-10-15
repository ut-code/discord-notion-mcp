<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import SearchIcon from "@lucide/svelte/icons/search";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { actionUrl } from "$lib/action-url";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { grantSubmitLabel } from "$lib/grant-label";
  import { useHydrated } from "$lib/hydrated.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import { DASHBOARD_PATH } from "$lib/paths";
  import type { GrantFormView } from "$lib/server/dashboard/grants";
  import SubjectPicker, { type GrantSubject } from "./subject-picker.svelte";

  let { form, filter }: { form: GrantFormView; filter: string | null } = $props();

  const hydrated = useHydrated();

  function initialSubject(view: GrantFormView): GrantSubject | null {
    const user = view.subjectType === "user" ? view.candidates.find((candidate) => candidate.id === view.selectedUserId) : undefined;
    if (user) return { type: "user", id: user.id, label: user.name, avatarUrl: user.avatarUrl };
    const role = view.roles.find((candidate) => candidate.id === view.preselectedRoleId);
    return role ? { type: "role", id: role.id, label: role.handle, color: role.color } : null;
  }

  // Form state follows the server data (e.g. after a member search) and the user's choices.
  let permission = $derived(form.permission);
  let subjectType = $derived(form.subjectType);
  let roleId = $derived(form.roleId);
  let userId = $derived(form.selectedUserId ?? "");
  // The inline search that replaces the controls below once JavaScript runs.
  let subject = $derived(initialSubject(form));

  const permissionOption = $derived(
    form.permissions.find((option) => option.value === permission) ??
      form.permissions[0] ?? { value: permission, label: permission, hint: "" },
  );
  const target = $derived(
    hydrated.current
      ? (subject?.label ?? null)
      : subjectType === "role"
        ? (form.roles.find((role) => role.id === roleId)?.handle ?? null)
        : (form.candidates.find((candidate) => candidate.id === userId)?.name ?? null),
  );
  const submitLabel = $derived(grantSubmitLabel(permissionOption.label, target));
</script>

<section class="panel panel-pad col-side gap-[18px]" aria-labelledby="add-grant">
  <h2 id="add-grant">{m.grants_add()}</h2>
  <form class="grant-form flex flex-col gap-[18px]" method="post" action={actionUrl(page.url, "create")} use:enhance>
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

    {#if hydrated.current}
      <SubjectPicker id="grant-subject" roles={form.roles} bind:selected={subject} />
      {#if subject}
        <input type="hidden" name="subjectType" value={subject.type} />
        <input type="hidden" name={subject.type === "role" ? "roleId" : "userId"} value={subject.id} />
      {/if}
    {:else}
      <fieldset class="m-0 min-w-0 border-0 p-0">
        <legend class="mb-2 p-0 text-sm font-medium">{m.grants_subject()}</legend>
        <div class="segmented">
          <label>
            <input type="radio" id="target-role" name="subjectType" value="role" bind:group={subjectType} />
            <span class="link-tab">{m.common_role()}</span>
          </label>
          <label>
            <input type="radio" id="target-user" name="subjectType" value="user" bind:group={subjectType} />
            <span class="link-tab">{m.common_user()}</span>
          </label>
        </div>
      </fieldset>

      <div class="only-role flex flex-col gap-2">
        <Label for="grant-role">{m.common_role()}</Label>
        <NativeSelect.Root id="grant-role" name="roleId" class="w-full" bind:value={roleId}>
          {#each form.roles as role (role.id)}
            <option value={role.id}>{role.name}</option>
          {/each}
        </NativeSelect.Root>
      </div>

      <div class="only-user flex flex-col gap-2">
        <Label for="grant-q">{m.grants_member_search_label()}</Label>
        <div class="search">
          <button
            class="search-icon"
            type="submit"
            formmethod="get"
            formaction={`${DASHBOARD_PATH}/grants`}
            formnovalidate
            aria-label={m.common_search()}
          >
            <SearchIcon class="size-4" />
          </button>
          <Input
            id="grant-q"
            name="q"
            type="search"
            value={form.query}
            autocomplete="off"
            placeholder={m.grants_member_search_placeholder()}
          />
        </div>
        {#if form.searchError}
          <div class="picker"><p class="px-2 py-2.5 text-note text-bad-fg">{form.searchError}</p></div>
        {:else if form.candidates.length > 0}
          <div class="picker" role="radiogroup" aria-label={m.grants_member_choices_label()}>
            {#each form.candidates as user (user.id)}
              <label class="pick">
                <input type="radio" name="userId" value={user.id} bind:group={userId} />
                <AppAvatar name={user.name} url={user.avatarUrl} size="md" />
                <span class="stack">
                  <span class="text-sm font-medium">{user.name}</span>
                  <span class="mono">{user.secondLine}</span>
                </span>
                <span class="pick-check"><CheckIcon class="size-4" /></span>
              </label>
            {/each}
          </div>
        {:else if form.query}
          <div class="picker">
            <p class="px-2 py-2.5 text-note text-muted-foreground">{m.grants_member_no_match({ query: form.query })}</p>
          </div>
        {/if}
      </div>
    {/if}

    <Button type="submit" class="w-full" disabled={hydrated.current && !subject}>{submitLabel}</Button>
  </form>
</section>
