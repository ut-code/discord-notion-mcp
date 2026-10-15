<script lang="ts">
  import SearchIcon from "@lucide/svelte/icons/search";
  import UserIcon from "@lucide/svelte/icons/user";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import Pager from "$lib/components/app/pager.svelte";
  import ToneBadge from "$lib/components/app/tone-badge.svelte";
  import { Input } from "$lib/components/ui/input";
  import * as Table from "$lib/components/ui/table";
  import { onDestroy } from "svelte";
  import { afterNavigate, goto } from "$app/navigation";
  import { useHydrated } from "$lib/hydrated.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import type { PageProps } from "./$types";
  import { DASHBOARD_PATH } from "$lib/paths";
  import UserMenu from "./user-menu.svelte";

  let { data }: PageProps = $props();

  const SEARCH_DEBOUNCE_MS = 300;
  const hydrated = useHydrated();
  // Local so results arriving mid-typing do not overwrite newer keystrokes; other navigations resync it.
  // svelte-ignore state_referenced_locally
  let query = $state(data.query);
  let timer: ReturnType<typeof setTimeout> | undefined;

  afterNavigate(({ type }) => {
    if (type !== "goto") query = data.query;
  });
  onDestroy(() => clearTimeout(timer));

  function searchAsYouType() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = query.trim();
      if (q === data.query) return;
      void goto(`${DASHBOARD_PATH}/users${q ? `?q=${encodeURIComponent(q)}` : ""}`, {
        keepFocus: true,
        noScroll: true,
        replaceState: true,
      });
    }, SEARCH_DEBOUNCE_MS);
  }
</script>

<PageHeader title={m.users_title()} />

<div class="footer-row">
  <form class="search min-w-[220px] flex-[0_1_320px]" method="get" action={`${DASHBOARD_PATH}/users`} role="search">
    {#if hydrated.current}
      <span class="search-icon pointer-events-none" aria-hidden="true"><SearchIcon class="size-4" /></span>
    {:else}
      <button class="search-icon" type="submit" aria-label={m.common_search()}><SearchIcon class="size-4" /></button>
    {/if}
    <label for="user-q" class="sr-only">{m.users_search_label()}</label>
    <Input
      id="user-q"
      name="q"
      type="search"
      bind:value={query}
      oninput={searchAsYouType}
      placeholder={m.users_search_placeholder()}
      autocomplete="off"
    />
  </form>
  <span class="text-[13px] text-muted-foreground">{m.users_total({ count: data.total })}</span>
</div>

<div class="table-wrap">
  <Table.Root class="data-table table-tall">
    <Table.Header>
      <Table.Row>
        <Table.Head>{m.common_user()}</Table.Head>
        <Table.Head>{m.common_permission()}</Table.Head>
        <Table.Head>{m.users_last_login()}</Table.Head>
        <Table.Head class="actions"><span class="sr-only">{m.common_actions()}</span></Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each data.rows as row, index (row.userId)}
        <Table.Row>
          <Table.Cell class="primary">
            <div class="cell-subject gap-3" title={row.title}>
              <AppAvatar name={row.displayName} url={row.avatarUrl} />
              <div class="stack gap-[3px]">
                <span class="font-medium">
                  {row.displayName}
                  {#if row.username}<span class="sub font-normal">@{row.username}</span>{/if}
                </span>
                <span class="sub" title={row.roles.title ?? undefined}>{row.roles.text}</span>
              </div>
            </div>
          </Table.Cell>
          <Table.Cell>
            {#if row.permissions.length === 0}
              <span class="text-muted-foreground">—</span>
            {:else}
              <span class="cluster">
                {#each row.permissions as permission (permission.label)}
                  <ToneBadge badge={permission}>
                    {#if permission.individual}<UserIcon class="size-3" aria-hidden="true" />{/if}
                  </ToneBadge>
                {/each}
              </span>
            {/if}
          </Table.Cell>
          <Table.Cell class="secondary">
            <span class="cluster">
              {row.lastLogin}
              {#if row.revoked}<ToneBadge badge={row.revoked} />{/if}
            </span>
          </Table.Cell>
          <Table.Cell class="actions"><UserMenu {row} {index} canRevoke={data.canRevoke} /></Table.Cell>
        </Table.Row>
      {:else}
        <Table.Row>
          <Table.Cell class="empty" colspan={4}>{data.empty}</Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>

<div class="footer-row">
  <Pager prev={data.prevHref} next={data.nextHref} />
</div>
