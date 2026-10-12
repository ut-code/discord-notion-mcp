<script lang="ts">
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import CopyButton from "$lib/components/app/copy-button.svelte";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import StatusBadges from "$lib/components/app/status-badges.svelte";
  import ToneBadge from "$lib/components/app/tone-badge.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Table from "$lib/components/ui/table";
  import { ADMIN_PATH } from "$lib/paths";

  let { data } = $props();
</script>

<PageHeader title="概要">
  {#snippet action()}
    <Button variant="outline" href={`${ADMIN_PATH}/grants`}>
      <PlusIcon />
      権限を付与
    </Button>
  {/snippet}
</PageHeader>

{#if data.recentFailures > 0}
  <div class="border-bad-border bg-bad-bg flex flex-wrap items-center gap-3 rounded-[10px] border px-4 py-3" role="status">
    <CircleAlertIcon class="text-bad-fg size-4" />
    <span class="text-bad-text grow text-sm">失敗した Notion への書き込みが {data.recentFailures} 件あります。</span>
    <Button variant="outline" size="sm" class="border-bad-border" href={data.failuresHref}>確認する</Button>
  </div>
{/if}

<div class="columns columns-tight">
  <section class="panel panel-clip col-main" aria-labelledby="recent-heading">
    <div class="panel-head panel-head-lg">
      <h2 id="recent-heading">最近の書き込み</h2>
      <Button variant="outline" size="sm" href={`${ADMIN_PATH}/audit`}>すべて見る</Button>
    </div>
    <Table.Root class="data-table">
      <Table.Header>
        <Table.Row>
          <Table.Head>#</Table.Head>
          <Table.Head>操作</Table.Head>
          <Table.Head>ユーザー</Table.Head>
          <Table.Head>対象</Table.Head>
          <Table.Head>状態</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.recent as row (row.id)}
          <Table.Row>
            <Table.Cell><a class="mono" href={row.href} aria-label={`#${row.id} の詳細`}>{row.id}</a></Table.Cell>
            <Table.Cell><ToneBadge badge={{ label: row.operation, tone: "outline" }} /></Table.Cell>
            <Table.Cell>{row.user.name}</Table.Cell>
            <Table.Cell class="primary">{row.title}</Table.Cell>
            <Table.Cell><StatusBadges badges={row.compactBadges} /></Table.Cell>
          </Table.Row>
        {:else}
          <Table.Row>
            <Table.Cell class="empty" colspan={5}>まだ書き込みはありません。</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </section>

  <div class="col-side basis-[300px]">
    <section class="panel panel-pad gap-3" aria-labelledby="url-heading">
      <h2 id="url-heading">接続 URL</h2>
      <p class="sub text-[13px]">Claude Code / Codex に登録する MCP エンドポイント。</p>
      <div class="flex items-center gap-2">
        <code class="code-box">{data.mcpUrl}</code>
        <CopyButton text={data.mcpUrl} label="URL をコピー" />
      </div>
    </section>
  </div>
</div>
