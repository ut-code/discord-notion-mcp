<script lang="ts">
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Table from "$lib/components/ui/table";
  import StackedBars from "./stacked-bars.svelte";

  let { data } = $props();

  const summary = $derived([
    { label: "呼び出し", value: data.summary.calls.toLocaleString("ja-JP") },
    { label: "利用者", value: data.summary.activeUsers.toLocaleString("ja-JP") },
    { label: "失敗率", value: data.summary.failureRate },
    { label: "レート制限", value: data.summary.rateLimited.toLocaleString("ja-JP") },
  ]);
  const notionTotals = $derived([
    { label: "書き込み", value: data.notion.writes },
    { label: "取り消し", value: data.notion.reverts },
    { label: "失敗", value: data.notion.failures },
  ]);
</script>

<PageHeader title="統計">
  {#snippet action()}
    <nav class="link-tabs" aria-label="期間">
      {#each data.ranges as range (range.href)}
        <a class="link-tab" href={range.href} aria-current={range.active ? "page" : undefined}>{range.label}</a>
      {/each}
    </nav>
  {/snippet}
</PageHeader>

{#if data.empty}
  <div class="panel px-5 py-10 text-center text-muted-foreground">まだ記録がありません。</div>
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
    <h2 id="daily-heading">日別の呼び出し</h2>
    <StackedBars rows={data.daily.rows} series={data.daily.series} label="日別・権限別の呼び出し回数" />
  </section>

  <div class="columns">
    <section class="stat-col gap-3" aria-labelledby="users-heading">
      <h2 id="users-heading">ユーザー</h2>
      <div class="table-wrap">
        <Table.Root class="data-table">
          <Table.Header>
            <Table.Row>
              <Table.Head>ユーザー</Table.Head>
              <Table.Head class="num">呼び出し</Table.Head>
              <Table.Head class="num">失敗率</Table.Head>
              <Table.Head class="num">最終利用</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.users as row (row.id)}
              <Table.Row>
                <Table.Cell class="primary">
                  <div class="cell-user" title={`Discord ID ${row.id}`}>
                    <AppAvatar name={row.name} url={row.avatarUrl} size="sm" />
                    {row.name}
                  </div>
                </Table.Cell>
                <Table.Cell class="num" data-label="呼び出し">{row.calls}</Table.Cell>
                <Table.Cell class="num" data-label="失敗率">{row.failureRate}</Table.Cell>
                <Table.Cell class="num secondary" data-label="最終利用">{row.lastUsed}</Table.Cell>
              </Table.Row>
            {:else}
              <Table.Row>
                <Table.Cell class="empty" colspan={4}>まだ記録がありません。</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    </section>

    <section class="stat-col gap-3" aria-labelledby="tools-heading">
      <h2 id="tools-heading">ツール</h2>
      <div class="table-wrap">
        <Table.Root class="data-table">
          <Table.Header>
            <Table.Row>
              <Table.Head>ツール</Table.Head>
              <Table.Head class="num">呼び出し</Table.Head>
              <Table.Head class="num">失敗率</Table.Head>
              <Table.Head class="num">平均時間</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.tools as row (row.tool)}
              <Table.Row>
                <Table.Cell class="primary"><span class="mono text-foreground">{row.tool}</span></Table.Cell>
                <Table.Cell class="num" data-label="呼び出し">{row.calls}</Table.Cell>
                <Table.Cell class="num" data-label="失敗率">{row.failureRate}</Table.Cell>
                <Table.Cell class="num secondary" data-label="平均時間">{row.avgDuration}</Table.Cell>
              </Table.Row>
            {:else}
              <Table.Row>
                <Table.Cell class="empty" colspan={4}>まだ記録がありません。</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    </section>
  </div>

  <section class="panel panel-pad flex flex-row flex-wrap items-center gap-x-6 gap-y-3" aria-labelledby="notion-heading">
    <h2 id="notion-heading">Notion 書き込み</h2>
    <dl class="cluster grow gap-x-4 text-[13px]">
      {#each notionTotals as total (total.label)}
        <div class="flex items-baseline gap-1.5">
          <dt class="text-muted-foreground">{total.label}</dt>
          <dd class="font-medium tabular-nums">{total.value.toLocaleString("ja-JP")}</dd>
        </div>
      {/each}
    </dl>
    {#if data.notion.auditHref}
      <Button variant="outline" size="sm" href={data.notion.auditHref}>履歴を見る</Button>
    {/if}
  </section>
{/if}
