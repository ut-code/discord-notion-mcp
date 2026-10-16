<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import SearchIcon from "@lucide/svelte/icons/search";
  import { onDestroy } from "svelte";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import { Input } from "$lib/components/ui/input";
  import { MAX_QUERY_LENGTH, namesMatch, searchNeedle } from "$lib/name-match";
  import { m } from "$lib/paraglide/messages.js";
  import { DASHBOARD_PATH } from "$lib/paths";
  import type { GrantFormView, SubjectOption } from "$lib/server/dashboard/grants";
  import { MemberLookup } from "./member-lookup.svelte";

  // One markup with and without JavaScript: the tabs switch in CSS, and the search box
  // filters as you type, or without JavaScript submits a GET search (Enter or the icon).
  let { id, form, chosen = $bindable() }: { id: string; form: GrantFormView; chosen: SubjectOption | null } = $props();

  let query = $derived(form.query);
  let tab = $derived<"role" | "user">(form.selected?.type ?? "role");
  let input = $state<HTMLInputElement | null>(null);
  const lookup = new MemberLookup(`${DASHBOARD_PATH}/grants/members`);
  onDestroy(() => lookup.cancel());

  const needle = $derived(searchNeedle(query));
  // The page's own search results stand until the query changes; then the live search's.
  const rendered = $derived(query.trim() === form.query);
  const roleMatches = $derived(form.roles.filter((role) => namesMatch([role.label], needle)));
  const memberMatches = $derived(rendered ? form.results : lookup.members);
  const memberError = $derived(rendered ? form.membersError : lookup.error);
  const loading = $derived(!rendered && lookup.loading);
  const listed = $derived(needle ? [...roleMatches, ...memberMatches] : [...form.roles, ...form.members]);
  // A choice the list no longer shows is still sent.
  const unlisted = $derived(chosen && !listed.some((option) => option.key === chosen?.key) ? chosen : null);

  function onkeydown(event: KeyboardEvent) {
    // Searching is live; Enter would submit the grant.
    if (event.key === "Enter" && !event.isComposing) event.preventDefault();
  }
</script>

{#snippet heading(text: string)}
  <div class="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{text}</div>
{/snippet}

{#snippet note(text: string, tone: "muted" | "bad" = "muted")}
  <p class={["px-2 py-1.5 text-note", tone === "bad" ? "text-bad-fg" : "text-muted-foreground"]}>{text}</p>
{/snippet}

{#snippet option(subject: SubjectOption)}
  <label class="pick">
    <input type="radio" name="subject" value={subject.key} checked={chosen?.key === subject.key} onchange={() => (chosen = subject)} />
    {#if subject.type === "role"}
      <span class="inline-flex size-7 shrink-0 items-center justify-center"
        ><span class="dot" style:background={subject.color ?? undefined}></span></span
      >
      <span class="min-w-0 flex-1 truncate text-sm">{subject.label}</span>
    {:else}
      <AppAvatar name={subject.label} url={subject.avatarUrl} size="md" />
      <span class="stack min-w-0">
        <span class="truncate text-sm">{subject.label}</span>
        <span class="mono truncate">{subject.secondLine}</span>
      </span>
    {/if}
    <span class="pick-check"><CheckIcon class="size-4" /></span>
  </label>
{/snippet}

<fieldset class="subject-field m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
  <legend class="mb-2 p-0 text-sm leading-none font-medium">{m.grants_subject()}</legend>
  <div class="search">
    <button
      class="search-icon"
      type="submit"
      formmethod="get"
      formaction={`${DASHBOARD_PATH}/grants`}
      formnovalidate
      aria-label={m.common_search()}
      onclick={(event) => {
        event.preventDefault();
        input?.focus();
      }}
    >
      {#if loading}
        <LoaderCircleIcon class="size-4 animate-spin" />
      {:else}
        <SearchIcon class="size-4" />
      {/if}
    </button>
    <Input
      bind:ref={input}
      bind:value={query}
      id={`${id}-q`}
      name="q"
      type="search"
      autocomplete="off"
      spellcheck={false}
      maxlength={MAX_QUERY_LENGTH}
      placeholder={m.grants_picker_placeholder()}
      aria-label={m.grants_picker_placeholder()}
      oninput={(event) => lookup.search(event.currentTarget.value)}
      {onkeydown}
    />
    <span class="sr-only" role="status">{loading ? m.grants_picker_loading() : ""}</span>
  </div>

  {#if needle}
    <div class="picker subject-list">
      {#if roleMatches.length > 0}
        {@render heading(m.common_role())}
        {#each roleMatches as role (role.key)}{@render option(role)}{/each}
      {/if}
      {#if memberMatches.length > 0}
        {@render heading(m.grants_picker_members())}
        {#each memberMatches as member (member.key)}{@render option(member)}{/each}
      {/if}
      {#if memberError}
        {@render note(memberError, "bad")}
      {:else if roleMatches.length === 0 && memberMatches.length === 0 && !loading}
        {@render note(m.grants_picker_no_match())}
      {/if}
    </div>
  {:else}
    <div class="segmented" role="radiogroup" aria-label={m.grants_list_switch_label()}>
      <label>
        <input type="radio" name="list" value="role" bind:group={tab} />
        <span class="link-tab">{m.common_role()}</span>
      </label>
      <label>
        <input type="radio" name="list" value="user" bind:group={tab} />
        <span class="link-tab">{m.grants_picker_members()}</span>
      </label>
    </div>
    <div class="picker subject-list">
      <div class="tab-roles">
        {#each form.roles as role (role.key)}{@render option(role)}{/each}
      </div>
      <div class="tab-members">
        {#each form.members as member (member.key)}{@render option(member)}{/each}
        {#if form.membersError}
          {@render note(form.membersError, "bad")}
        {:else if form.moreMembers > 0}
          {@render note(m.grants_members_more({ count: form.moreMembers }))}
        {/if}
      </div>
    </div>
  {/if}
  {#if unlisted}<input type="hidden" name="subject" value={unlisted.key} />{/if}
</fieldset>
