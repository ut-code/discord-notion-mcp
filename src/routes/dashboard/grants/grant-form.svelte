<script lang="ts">
  import InfoIcon from "@lucide/svelte/icons/info";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { untrack } from "svelte";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { actionUrl } from "#lib/action-url.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import { grantSubmitLabel, MAX_GRANTS_PER_SUBMIT } from "#lib/grant-form.js";
  import { formatNumber } from "#lib/locale.js";
  import { useHydrated } from "#lib/hydrated.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { GrantFormView } from "#lib/server/dashboard/grants.js";
  import type { Permission } from "#lib/server/permissions/permissions.js";
  import SubjectList from "./subject-list.svelte";

  let { form, filter }: { form: GrantFormView; filter: string | null } = $props();

  const hydrated = useHydrated();

  // The choices start from the URL (a link from the users page, a search without JavaScript) and
  // are the user's after that. The page data is reloaded after every grant or removal, so they are
  // derived from the URL's choices as strings: an equal string does not recompute them, and the
  // user's choices survive, while a link naming other ones replaces them.
  // Permissions are picked per service (Discord: none or read; Notion: none, read or write) or as
  // admin, which includes them all: a pick that would add nothing cannot be made.
  const urlPermissions = $derived(form.chosenPermissions.join(" "));
  const urlHas = (permission: Permission) => urlPermissions.split(" ").includes(permission);
  let admin = $derived(urlHas("admin"));
  let discord = $derived<"" | "discord:read">(urlHas("discord:read") ? "discord:read" : "");
  let notion = $derived<"" | "notion:read" | "notion:write">(
    urlHas("notion:write") ? "notion:write" : urlHas("notion:read") ? "notion:read" : "",
  );
  const permissions = $derived<Permission[]>(admin ? ["admin"] : [discord, notion].filter((value) => value !== ""));
  // Admin includes the levels, so they cannot be picked beside it. Without JavaScript they stay
  // open, since unchecking admin could not open them again; the server then grants admin alone.
  const locked = $derived(hydrated.current && admin);
  const urlSubjects = $derived(form.selectedKeys.join(" "));
  let chosen = $derived(urlSubjects ? untrack(() => [...form.selected]) : []);

  const option = (value: Permission) => form.permissions.find((candidate) => candidate.value === value);
  const permissionLabel = (value: Permission) => option(value)?.label ?? value;
  const levelLabel = (level: "" | Permission) =>
    level === "" ? m.grants_level_none() : level.endsWith(":write") ? m.grants_level_write() : m.grants_level_read();
  const pairs = $derived(chosen.flatMap((subject) => permissions.map((permission) => ({ subject, permission }))));
  // Exact repeats are not sent again; a permission a subject gets some other way is, with the
  // reason it adds nothing.
  const fresh = $derived(pairs.filter(({ subject, permission }) => !subject.granted.includes(permission)).length);
  const tooMany = $derived(pairs.length > MAX_GRANTS_PER_SUBMIT);
  // One line per subject and reason, naming its permissions: "Mina の Discord 閲覧・Notion 閲覧：…".
  const notices = $derived.by(() => {
    const lines: Array<{ key: string; subject: string; permissions: string[]; notice: string }> = [];
    for (const { subject, permission } of pairs) {
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

<!-- Before hydration (and without JavaScript) a native popover stands in, as in row-menu.svelte. -->
{#snippet hint(name: string, id: string, lines: string[])}
  {@const triggerClass = "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"}
  {#if hydrated.current}
    <Popover.Root>
      <Popover.Trigger type="button" class={triggerClass} aria-label={m.grants_permission_hint({ permission: name })}>
        <InfoIcon class="size-3.5" />
      </Popover.Trigger>
      <Popover.Content side="top" class="flex w-64 flex-col gap-1.5 p-3 text-xs leading-relaxed">
        {#each lines as line (line)}<p>{line}</p>{/each}
      </Popover.Content>
    </Popover.Root>
  {:else}
    <button
      type="button"
      class={triggerClass}
      popovertarget={`${id}-popover`}
      aria-label={m.grants_permission_hint({ permission: name })}
      style={`anchor-name:--${id}`}
    >
      <InfoIcon class="size-3.5" />
    </button>
    <div class="native-hint" id={`${id}-popover`} popover="auto" style={`position-anchor:--${id}`}>
      {#each lines as line (line)}<p>{line}</p>{/each}
    </div>
  {/if}
  <span {id} class="sr-only">{lines.join(" ")}</span>
{/snippet}

<!-- One service's level: "" grants nothing for it. -->
{#snippet service(name: "discord" | "notion", label: string, levels: Array<"" | Permission>)}
  {@const described = levels.flatMap((level) => {
    const found = level ? option(level) : undefined;
    return found ? [found] : [];
  })}
  <div class="flex items-center gap-2.5">
    <span id={`grant-${name}-label`} class="w-14 shrink-0 text-sm font-medium">{label}</span>
    <div
      class={["segmented flex-1", levels.length === 3 && "grid-cols-3", locked && "opacity-50"]}
      role="radiogroup"
      aria-labelledby={`grant-${name}-label`}
      aria-describedby={`grant-${name}-hint`}
    >
      {#each levels as level (level)}
        <label>
          {#if name === "discord"}
            <input type="radio" {name} value={level} disabled={locked} bind:group={discord} />
          {:else}
            <input type="radio" {name} value={level} disabled={locked} bind:group={notion} />
          {/if}
          <span class="link-tab">{levelLabel(level)}</span>
        </label>
      {/each}
    </div>
    {@render hint(
      label,
      `grant-${name}-hint`,
      described.map((found) =>
        described.length > 1 ? m.grants_level_hint({ level: levelLabel(found.value), hint: found.hint }) : found.hint,
      ),
    )}
  </div>
{/snippet}

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
    <fieldset class="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
      <legend class="mb-2 p-0 text-sm leading-none font-medium">{m.common_permission()}</legend>
      <!-- What each choice allows is a hint behind the ⓘ button, and the description screen readers hear. -->
      <div class="flex flex-col gap-2">
        {@render service("discord", "Discord", ["", "discord:read"])}
        {@render service("notion", "Notion", ["", "notion:read", "notion:write"])}
      </div>
      <div class="flex items-center gap-2.5">
        <input
          type="checkbox"
          id="grant-admin"
          class="size-4 shrink-0 accent-primary"
          name="permission"
          value="admin"
          aria-describedby="grant-admin-hint"
          bind:checked={admin}
        />
        <label for="grant-admin" class="cursor-pointer text-sm leading-tight font-medium">{permissionLabel("admin")}</label>
        {@render hint(permissionLabel("admin"), "grant-admin-hint", [option("admin")?.hint ?? ""])}
      </div>
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
      {#if notices.length > 0 && !tooMany}
        <ul class="flex flex-col gap-1">
          {#each notices as notice (notice.key)}
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
