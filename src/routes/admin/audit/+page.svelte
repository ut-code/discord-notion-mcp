<script lang="ts">
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import ActionFeedback from "$lib/components/app/action-feedback.svelte";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import ExternalLink from "$lib/components/app/external-link.svelte";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import Pager from "$lib/components/app/pager.svelte";
  import StatusBadges from "$lib/components/app/status-badges.svelte";
  import ToneBadge from "$lib/components/app/tone-badge.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import * as Table from "$lib/components/ui/table";
  import { ADMIN_PATH } from "$lib/paths";

  let { data } = $props();
</script>

<PageHeader title="Notion 書き込み履歴" />
<ActionFeedback result={data.error ? { kind: "error", message: data.error } : null} />

<form class="flex flex-wrap items-center gap-2" method="get" action={`${ADMIN_PATH}/audit`}>
  <label for="filter-user" class="sr-only">ユーザー</label>
  <NativeSelect.Root id="filter-user" name="user" value={data.filters.user}>
    <option value="">すべてのユーザー</option>
    {#each data.userOptions as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </NativeSelect.Root>
  <label for="filter-operation" class="sr-only">操作</label>
  <NativeSelect.Root id="filter-operation" name="operation" value={data.filters.operation}>
    <option value="">すべての操作</option>
    {#each data.operationOptions as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </NativeSelect.Root>
  <label for="filter-status" class="sr-only">状態</label>
  <NativeSelect.Root id="filter-status" name="status" value={data.filters.status}>
    <option value="">すべての状態</option>
    {#each data.statusOptions as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </NativeSelect.Root>
  <Button type="submit" variant="outline">絞り込む</Button>
  <Button variant="ghost" class="text-text-4" href={`${ADMIN_PATH}/audit`}>リセット</Button>
</form>

<div class="table-wrap">
  <Table.Root class="data-table table-roomy table-hover">
    <Table.Header>
      <Table.Row>
        <Table.Head class="w-14">#</Table.Head>
        <Table.Head>日時</Table.Head>
        <Table.Head>ユーザー</Table.Head>
        <Table.Head>操作</Table.Head>
        <Table.Head>対象ページ</Table.Head>
        <Table.Head>状態</Table.Head>
        <Table.Head class="actions"><span class="sr-only">詳細</span></Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each data.rows as row (row.id)}
        <Table.Row>
          <Table.Cell class="mono">{row.id}</Table.Cell>
          <Table.Cell class="secondary">{row.createdAt}</Table.Cell>
          <Table.Cell>
            <div class="cell-user">
              <AppAvatar name={row.user.name} url={row.user.avatarUrl} size="sm" />
              {row.user.name}
            </div>
          </Table.Cell>
          <Table.Cell>
            <span class="cluster">
              <ToneBadge badge={{ label: row.operation, tone: "outline" }} />
              {#if row.revertOf !== null}<span class="mono">← #{row.revertOf}</span>{/if}
            </span>
          </Table.Cell>
          <Table.Cell class="primary">
            {#if row.targetUrl}<ExternalLink href={row.targetUrl}>{row.title}</ExternalLink>{:else}<span>{row.title}</span>{/if}
          </Table.Cell>
          <Table.Cell><StatusBadges badges={row.badges} /></Table.Cell>
          <Table.Cell class="actions">
            <Button variant="ghost" size="icon-sm" href={row.href} aria-label={`#${row.id} の詳細`}><ChevronRightIcon /></Button>
          </Table.Cell>
        </Table.Row>
      {:else}
        <Table.Row>
          <Table.Cell class="empty" colspan={7}>該当する記録はありません。</Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>

{#if data.range}
  <div class="footer-row">
    <span class="text-muted-foreground text-[13px]">{data.range}</span>
    <Pager prev={data.prevHref} next={data.nextHref} />
  </div>
{/if}
