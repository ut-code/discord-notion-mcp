<script lang="ts">
  import AppAvatar from "#lib/components/app/app-avatar.svelte";
  import PageHeader from "#lib/components/app/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import { formatNumber } from "#lib/locale.js";
  import { m } from "#lib/paraglide/messages.js";
  import StackedBars from "./stacked-bars.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const summary = $derived([
    { label: m.stats_calls(), value: formatNumber(data.summary.calls) },
    { label: m.stats_active_users(), value: formatNumber(data.summary.activeUsers) },
    { label: m.stats_failure_rate(), value: data.summary.failureRate },
    { label: m.stats_rate_limited(), value: formatNumber(data.summary.rateLimited) },
  ]);
  const notionTotals = $derived([
    { label: m.stats_notion_writes(), value: data.notion.writes },
    { label: m.stats_notion_reverts(), value: data.notion.reverts },
    { label: m.stats_notion_failures(), value: data.notion.failures },
  ]);
</script>

<PageHeader title={m.stats_title()}>
  {#snippet action()}
    <nav class="link-tabs" aria-label={m.stats_range_label()}>
      {#each data.ranges as range (range.href)}
        <a class="link-tab" href={range.href} aria-current={range.active ? "page" : undefined}>{range.label}</a>
      {/each}
    </nav>
  {/snippet}
</PageHeader>

{#if data.empty}
  <div class="panel px-5 py-10 text-center text-muted-foreground">{m.stats_empty()}</div>
{:else}
  <dl class="stat-tiles">
    {#each summary as tile (tile.label)}
      <div class="panel stat-tile">
        <dt>{tile.label}</dt>
        <dd>{tile.value}</dd>
      </div>
    {/each}
  </dl>

  <section class="panel panel-pad" aria-labelledby="daily-heading">
    <h2 id="daily-heading">{m.stats_daily_heading()}</h2>
    <StackedBars rows={data.daily.rows} series={data.daily.series} label={m.stats_daily_chart_label()} />
  </section>

  <div class="columns">
    <section class="stat-col gap-3" aria-labelledby="users-heading">
      <h2 id="users-heading">{m.users_title()}</h2>
      <div class="table-wrap">
        <Table.Root class="data-table figures-table">
          <Table.Header>
            <Table.Row>
              <Table.Head>{m.common_user()}</Table.Head>
              <Table.Head class="num">{m.stats_calls()}</Table.Head>
              <Table.Head class="num">{m.stats_failure_rate()}</Table.Head>
              <Table.Head class="num">{m.stats_last_used()}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.users as row (row.id)}
              <Table.Row>
                <Table.Cell class="primary">
                  <div class="cell-user" title={`Discord ID ${row.id}`}>
                    <AppAvatar name={row.name} url={row.avatarUrl} size="sm" />
                    <span class="scroll-x">{row.name}</span>
                  </div>
                </Table.Cell>
                <Table.Cell class="num">{formatNumber(row.calls)}</Table.Cell>
                <Table.Cell class="num">{row.failureRate}</Table.Cell>
                <Table.Cell class="num secondary">{row.lastUsed}</Table.Cell>
              </Table.Row>
            {:else}
              <Table.Row>
                <Table.Cell class="empty" colspan={4}>{m.stats_empty()}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    </section>

    <section class="stat-col gap-3" aria-labelledby="tools-heading">
      <h2 id="tools-heading">{m.stats_tools()}</h2>
      <div class="table-wrap">
        <Table.Root class="data-table figures-table">
          <Table.Header>
            <Table.Row>
              <Table.Head>{m.stats_tools()}</Table.Head>
              <Table.Head class="num">{m.stats_calls()}</Table.Head>
              <Table.Head class="num">{m.stats_failure_rate()}</Table.Head>
              <Table.Head class="num">{m.stats_avg_duration()}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.tools as row (row.tool)}
              <Table.Row>
                <Table.Cell class="primary"><span class="mono scroll-x text-foreground">{row.tool}</span></Table.Cell>
                <Table.Cell class="num">{formatNumber(row.calls)}</Table.Cell>
                <Table.Cell class="num">{row.failureRate}</Table.Cell>
                <Table.Cell class="num secondary">{row.avgDuration}</Table.Cell>
              </Table.Row>
            {:else}
              <Table.Row>
                <Table.Cell class="empty" colspan={4}>{m.stats_empty()}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    </section>
  </div>

  <section class="panel panel-pad flex flex-row flex-wrap items-center gap-x-6 gap-y-3" aria-labelledby="notion-heading">
    <h2 id="notion-heading">{m.stats_notion_heading()}</h2>
    <dl class="cluster grow gap-x-4 text-note">
      {#each notionTotals as total (total.label)}
        <div class="flex items-baseline gap-1.5">
          <dt class="text-muted-foreground">{total.label}</dt>
          <dd class="font-medium tabular-nums">{formatNumber(total.value)}</dd>
        </div>
      {/each}
    </dl>
    {#if data.notion.auditHref}
      <Button variant="outline" size="sm" href={data.notion.auditHref}>{m.stats_view_audit()}</Button>
    {/if}
  </section>
{/if}
