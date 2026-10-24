<script lang="ts">
  import InfoIcon from "@lucide/svelte/icons/info";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { untrack } from "svelte";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { actionUrl } from "#lib/action-url.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import { grantSubmitLabel, MAX_GRANTS_PER_SUBMIT } from "#lib/grant-label.js";
  import { formatNumber } from "#lib/locale.js";
  import { useHydrated } from "#lib/hydrated.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { GrantFormView } from "#lib/server/dashboard/grants.js";
  import SubjectList from "./subject-list.svelte";

  let { form, filter }: { form: GrantFormView; filter: string | null } = $props();

  const hydrated = useHydrated();

  // The choices start from the URL (a link from the users page, a search without JavaScript) and
  // are the user's after that. The page data is reloaded after every grant or removal, so they are
  // derived from the URL's choices as strings: an equal string does not recompute them, and the
  // user's choices survive, while a link naming other ones replaces them.
  const urlPermissions = $derived(form.chosenPermissions.join(" "));
  let permissions = $derived(
    untrack(() => form.permissions)
      .map((option) => option.value)
      .filter((value) => urlPermissions.split(" ").includes(value)),
  );
  const urlSubjects = $derived(form.selectedKeys.join(" "));
  let chosen = $derived(urlSubjects ? untrack(() => [...form.selected]) : []);

  const permissionLabel = (value: string) => form.permissions.find((option) => option.value === value)?.label ?? value;
  // In the order the permissions are listed, whichever was checked first.
  const pairs = $derived(
    chosen.flatMap((subject) =>
      form.permissions.flatMap(({ value }) => (permissions.includes(value) ? [{ subject, permission: value }] : [])),
    ),
  );
  // Exact repeats are not sent again; a permission a subject gets some other way is, with the
  // reason it adds nothing.
  const fresh = $derived(pairs.filter(({ subject, permission }) => !subject.granted.includes(permission)).length);
  const tooMany = $derived(pairs.length > MAX_GRANTS_PER_SUBMIT);
  // A checked permission another checked one includes (Notion 閲覧 with Notion 編集, anything with
  // 管理者), named by the broadest; such a permission gets this line instead of one per subject.
  const included = $derived(
    form.permissions.flatMap(({ value, label }) => {
      const by = form.permissions
        .filter((other) => other.value !== value && permissions.includes(other.value) && other.gives.includes(value))
        .sort((a, b) => b.gives.length - a.gives.length)[0];
      if (!by || !permissions.includes(value)) return [];
      const notice = m.grants_notice_redundant({ because: m.grants_redundant_included_because({ permission: by.label }) });
      return [{ key: `included ${value}`, permission: value, text: m.grants_notice_permission({ permission: label, notice }) }];
    }),
  );
  // One line per subject and reason, naming its permissions: "Mina の Discord 閲覧・Notion 閲覧：…".
  const notices = $derived.by(() => {
    const lines: Array<{ key: string; subject: string; permissions: string[]; notice: string }> = [];
    for (const { subject, permission } of pairs) {
      if (included.some((line) => line.permission === permission)) continue;
      const notice = subject.granted.includes(permission) ? m.grants_notice_granted() : subject.notices[permission];
      if (!notice) continue;
      const key = `${subject.key} ${notice}`;
      const line = lines.find((candidate) => candidate.key === key);
      if (line) line.permissions.push(permissionLabel(permission));
      else lines.push({ key, subject: subject.label, permissions: [permissionLabel(permission)], notice });
    }
    return lines.map((line) => ({
      key: line.key,
      text:
        pairs.length === 1
          ? line.notice
          : m.grants_notice_pair({ subject: line.subject, permission: line.permissions.join("・"), notice: line.notice }),
    }));
  });
  const submitLabel = $derived(
    grantSubmitLabel(
      chosen.map((subject) => subject.label),
      permissions.map(permissionLabel),
      fresh,
    ),
  );
</script>

<section class="panel panel-pad col-side gap-[18px]" aria-labelledby="add-grant">
  <h2 id="add-grant">{m.grants_add()}</h2>
  <form
    class="flex flex-col gap-[18px]"
    method="post"
    action={actionUrl(page.url, "create")}
    use:enhance={() =>
      ({ update }) =>
        update({ reset: false })}
  >
    {#if filter}<input type="hidden" name="filter" value={filter} />{/if}
    <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend class="mb-2 p-0 text-sm leading-none font-medium">
        {m.common_permission()}
      </legend>
      <!-- What each permission allows is a hint behind the ⓘ button, and the description screen readers hear. -->
      {#each form.permissions as option (option.value)}
        <div class="flex items-center gap-2.5">
          <input
            type="checkbox"
            id={`grant-permission-${option.value}`}
            class="size-4 shrink-0 accent-primary"
            name="permission"
            value={option.value}
            aria-describedby={`grant-permission-${option.value}-hint`}
            bind:group={permissions}
          />
          <label for={`grant-permission-${option.value}`} class="cursor-pointer text-sm leading-tight font-medium">{option.label}</label>
          <Popover.Root>
            <Popover.Trigger
              type="button"
              class="-ml-1.5 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              aria-label={m.grants_permission_hint({ permission: option.label })}
            >
              <InfoIcon class="size-3.5" />
            </Popover.Trigger>
            <Popover.Content side="top" class="w-64 p-3 text-xs leading-relaxed">{option.hint}</Popover.Content>
          </Popover.Root>
          <span id={`grant-permission-${option.value}-hint`} class="sr-only">{option.hint}</span>
        </div>
      {/each}
    </fieldset>

    <SubjectList id="grant-subject" {form} bind:chosen />

    <!-- Always there, so screen readers announce what appears in them; empty, they take no room. -->
    <div role="alert" class="empty:hidden">
      {#if tooMany}
        <p class="flex items-start gap-1.5 text-note text-bad-fg">
          <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />{m.grants_too_many({ max: formatNumber(MAX_GRANTS_PER_SUBMIT) })}
        </p>
      {/if}
    </div>
    <div role="status" class="empty:hidden">
      {#if included.length + notices.length > 0 && !tooMany}
        <ul class="flex flex-col gap-1">
          {#each [...included, ...notices] as notice (notice.key)}
            <li class="flex items-start gap-1.5 text-note text-warn-text">
              <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />{notice.text}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <!-- Without JavaScript the choices are not tracked here, so the server checks them instead. The
         label names who is chosen, so a long name wraps instead of running out of the button. -->
    <Button
      type="submit"
      class="h-auto min-h-9 w-full py-1.5 text-balance whitespace-normal"
      disabled={hydrated.current && (fresh === 0 || tooMany)}>{submitLabel}</Button
    >
  </form>
</section>
