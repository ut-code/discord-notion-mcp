<script lang="ts" module>
  export type GrantSubject =
    | { type: "role"; id: string; label: string; color: string | null }
    | { type: "user"; id: string; label: string; avatarUrl: string | null };
</script>

<script lang="ts">
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import SearchIcon from "@lucide/svelte/icons/search";
  import XIcon from "@lucide/svelte/icons/x";
  import { onDestroy, tick } from "svelte";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { m } from "$lib/paraglide/messages.js";
  import { DASHBOARD_PATH } from "$lib/paths";
  import type { CandidateView, GrantFormView } from "$lib/server/dashboard/grants";
  import { MemberLookup } from "./member-lookup.svelte";

  const ROLE_LIMIT = 6;

  let { id, roles, selected = $bindable() }: { id: string; roles: GrantFormView["roles"]; selected: GrantSubject | null } = $props();

  let query = $state("");
  /** Escape hides the candidates until the query changes. */
  let dismissed = $state(false);
  let activeKey = $state<string | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let clear = $state<HTMLButtonElement | null>(null);
  const lookup = new MemberLookup(`${DASHBOARD_PATH}/grants/members`);

  const labelId = $derived(`${id}-label`);
  const listId = $derived(`${id}-list`);
  const keyOf = (subject: GrantSubject) => `${subject.type}:${subject.id}`;
  const optionId = (subject: GrantSubject) => `${id}-option-${subject.type}-${subject.id}`;
  const fold = (text: string) => text.normalize("NFKC").toLowerCase();

  const needle = $derived(fold(query.trim().replace(/^@/, "")));
  const roleOptions = $derived<GrantSubject[]>(
    needle
      ? roles
          .filter((role) => fold(role.name).includes(needle))
          .slice(0, ROLE_LIMIT)
          .map((role) => ({ type: "role", id: role.id, label: role.handle, color: role.color }))
      : [],
  );
  const members = $derived<CandidateView[]>(needle ? lookup.members : []);
  const memberOptions = $derived(
    members.map((member) => ({
      subject: { type: "user", id: member.id, label: member.name, avatarUrl: member.avatarUrl } satisfies GrantSubject,
      secondLine: member.secondLine,
    })),
  );
  const options = $derived<GrantSubject[]>([...roleOptions, ...memberOptions.map((entry) => entry.subject)]);
  const open = $derived(needle !== "" && !dismissed);
  const active = $derived(options.find((option) => keyOf(option) === activeKey) ?? options[0]);
  const memberNote = $derived(
    members.length > 0 || lookup.loading ? null : (lookup.error ?? (roleOptions.length > 0 ? null : m.grants_picker_no_match())),
  );

  onDestroy(() => lookup.cancel());

  async function choose(subject: GrantSubject) {
    selected = subject;
    query = "";
    lookup.search(query);
    activeKey = null;
    await tick();
    clear?.focus();
  }

  async function reset() {
    selected = null;
    dismissed = false;
    await tick();
    input?.focus();
  }

  async function move(step: number) {
    if (!open || options.length === 0) return;
    const index = active ? options.indexOf(active) : -1;
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    activeKey = keyOf(next);
    await tick();
    document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      dismissed = false;
      void move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      // Never submit the form from the search box.
      event.preventDefault();
      if (open && active) void choose(active);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      dismissed = true;
    }
  }
</script>

{#snippet heading(text: string, headingId?: string)}
  <div id={headingId} class="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{text}</div>
{/snippet}

{#snippet option(subject: GrantSubject, secondLine?: string)}
  <!-- Focus stays on the input (aria-activedescendant); the keyboard is handled there. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    id={optionId(subject)}
    class="pick"
    role="option"
    tabindex="-1"
    aria-selected={subject === active}
    data-active={subject === active ? "" : undefined}
    onmousedown={(event) => event.preventDefault()}
    onmousemove={() => (activeKey = keyOf(subject))}
    onclick={() => choose(subject)}
  >
    {#if subject.type === "role"}
      <span class="dot" style:background={subject.color ?? undefined}></span>
      <span class="truncate text-sm">{subject.label}</span>
    {:else}
      <AppAvatar name={subject.label} url={subject.avatarUrl} size="md" />
      <span class="stack">
        <span class="truncate text-sm">{subject.label}</span>
        <span class="mono truncate">{secondLine}</span>
      </span>
    {/if}
  </div>
{/snippet}

<div class="flex flex-col gap-2">
  <Label id={labelId} for={selected ? undefined : id}>{m.grants_subject()}</Label>
  {#if selected}
    <div
      role="group"
      aria-labelledby={labelId}
      class="flex h-9 min-w-0 items-center gap-2 rounded-md border border-input pr-0.5 pl-2.5 text-sm"
    >
      {#if selected.type === "role"}
        <span class="dot" style:background={selected.color ?? undefined}></span>
      {:else}
        <AppAvatar name={selected.label} url={selected.avatarUrl} size="sm" />
      {/if}
      <span class="min-w-0 flex-1 truncate">{selected.label}</span>
      <Button bind:ref={clear} variant="ghost" size="icon-sm" aria-label={m.grants_picker_clear()} onclick={reset}>
        <XIcon />
      </Button>
    </div>
  {:else}
    <div class="search">
      <span class="search-icon pointer-events-none" aria-hidden="true"><SearchIcon class="size-4" /></span>
      <Input
        bind:ref={input}
        bind:value={query}
        {id}
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck={false}
        placeholder={m.grants_picker_placeholder()}
        aria-autocomplete="list"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && active ? optionId(active) : undefined}
        class="pr-9"
        oninput={(event) => {
          dismissed = false;
          lookup.search(event.currentTarget.value);
        }}
        {onkeydown}
      />
      {#if lookup.loading}
        <span class="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground" role="status" aria-label={m.grants_picker_loading()}>
          <LoaderCircleIcon class="size-4 animate-spin" />
        </span>
      {/if}
    </div>
    <div class={["picker", !(open && (options.length > 0 || memberNote)) && "hidden"]}>
      <div id={listId} role="listbox" aria-labelledby={labelId}>
        {#if open && roleOptions.length > 0}
          <div role="group" aria-labelledby={`${id}-roles`}>
            {@render heading(m.common_role(), `${id}-roles`)}
            {#each roleOptions as subject (keyOf(subject))}
              {@render option(subject)}
            {/each}
          </div>
        {/if}
        {#if open && members.length > 0}
          <div role="group" aria-labelledby={`${id}-members`}>
            {@render heading(m.grants_picker_members(), `${id}-members`)}
            {#each memberOptions as entry (entry.subject.id)}
              {@render option(entry.subject, entry.secondLine)}
            {/each}
          </div>
        {/if}
      </div>
      {#if open && memberNote}
        <p class={["px-2 py-1.5 text-[13px]", lookup.error ? "text-bad-fg" : "text-muted-foreground"]} role="status">{memberNote}</p>
      {/if}
    </div>
  {/if}
</div>
