<script lang="ts">
  import ActionFeedback from "#lib/components/app/action-feedback.svelte";
  import AppAvatar from "#lib/components/app/app-avatar.svelte";
  import FilterPanel, { type FilterField } from "#lib/components/app/filter-panel.svelte";
  import HistoryTabs from "#lib/components/app/history-tabs.svelte";
  import PageHeader from "#lib/components/app/page-header.svelte";
  import Pager from "#lib/components/app/pager.svelte";
  import ToneBadge from "#lib/components/app/tone-badge.svelte";
  import * as Table from "#lib/components/ui/table/index.js";
  import { m } from "#lib/paraglide/messages.js";
  import { CALLS_PATH } from "#lib/paths.js";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const fields = $derived<FilterField[]>([
    ...(data.canFilterUsers
      ? [{ name: "user", label: m.common_user(), value: data.filters.user, allLabel: m.filter_all_users(), options: data.userOptions }]
      : []),
    {
      name: "status",
      label: m.common_status(),
      value: data.filters.status,
      allLabel: m.filter_all_statuses(),
      options: data.statusOptions,
    },
  ]);
  // Shares of the table width (see .history-table): the tool takes the most, not all of the rest.
  const columns = $derived(data.canFilterUsers ? ["16%", "20%", "34%", "15%", "15%"] : ["20%", "46%", "17%", "17%"]);
  const resetHref = $derived(`${CALLS_PATH}?${new URLSearchParams({ permission: data.permission })}`);
</script>

<PageHeader title={m.history_title()} />
<HistoryTabs tabs={data.tabs} />
<ActionFeedback result={data.error ? { kind: "error", message: data.error } : null} />
<FilterPanel action={CALLS_PATH} {fields} hidden={{ permission: data.permission }} {resetHref} />

<div class="table-wrap history-wrap">
  <!-- Phones: a compact list in place of the table. -->
  <div class="history-list">
    {#if data.rows.length > 0}
      <ul>
        {#each data.rows as row (row.id)}
          <li class="history-item">
            <span class="history-item-head">
              <a class="history-item-title mono text-foreground" href={row.toolHref}>{row.tool}</a>
              {#if row.badge}<ToneBadge badge={row.badge} />{/if}
            </span>
            <span class="history-item-meta">{row.meta}</span>
            {#if row.error}<span class="call-error">{row.error}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="history-list-empty">{m.calls_empty()}</p>
    {/if}
  </div>
  <Table.Root class="data-table table-roomy history-table">
    <colgroup>
      {#each columns as share, index (index)}<col style:--share={share} />{/each}
    </colgroup>
    <Table.Header>
      <Table.Row>
        <Table.Head>{m.audit_time()}</Table.Head>
        {#if data.canFilterUsers}<Table.Head>{m.common_user()}</Table.Head>{/if}
        <Table.Head>{m.stats_tools()}</Table.Head>
        <Table.Head>{m.common_status()}</Table.Head>
        <Table.Head class="num">{m.calls_duration()}</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each data.rows as row (row.id)}
        <Table.Row>
          <Table.Cell class="secondary">{row.createdAt}</Table.Cell>
          {#if data.canFilterUsers}
            <Table.Cell>
              <div class="cell-user">
                <AppAvatar name={row.user.name} url={row.user.avatarUrl} size="sm" />
                <span class="scroll-x">{row.user.name}</span>
              </div>
            </Table.Cell>
          {/if}
          <Table.Cell class="primary">
            <div class="stack">
              <a class="mono scroll-x text-foreground hover:underline" href={row.toolHref}>{row.tool}</a>
              {#if row.error}<span class="call-error">{row.error}</span>{/if}
            </div>
          </Table.Cell>
          <Table.Cell><ToneBadge badge={row.status} /></Table.Cell>
          <Table.Cell class="num secondary">{row.duration}</Table.Cell>
        </Table.Row>
      {:else}
        <Table.Row>
          <Table.Cell class="empty" colspan={columns.length}>{m.calls_empty()}</Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>

<div class="footer-row">
  <span class="text-note text-muted-foreground">{data.summary}</span>
  {#if data.range || data.prevHref}<Pager prev={data.prevHref} next={data.nextHref} />{/if}
</div>
