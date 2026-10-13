<script lang="ts">
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import ListFilterIcon from "@lucide/svelte/icons/list-filter";
  import ActionFeedback from "$lib/components/app/action-feedback.svelte";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import AuditList from "$lib/components/app/audit-list.svelte";
  import ExternalLink from "$lib/components/app/external-link.svelte";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import Pager from "$lib/components/app/pager.svelte";
  import ToneBadge from "$lib/components/app/tone-badge.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import * as Table from "$lib/components/ui/table";
  import { DASHBOARD_PATH } from "$lib/paths";

  let { data } = $props();

  const activeFilters = $derived(Object.values(data.filters).filter(Boolean).length);
</script>

{#snippet filterFields(idPrefix: string, selectClass: string)}
  <label for={`${idPrefix}filter-user`} class="sr-only">ユーザー</label>
  <NativeSelect.Root id={`${idPrefix}filter-user`} name="user" value={data.filters.user} class={selectClass}>
    <option value="">すべてのユーザー</option>
    {#each data.userOptions as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </NativeSelect.Root>
  <label for={`${idPrefix}filter-operation`} class="sr-only">操作</label>
  <NativeSelect.Root id={`${idPrefix}filter-operation`} name="operation" value={data.filters.operation} class={selectClass}>
    <option value="">すべての操作</option>
    {#each data.operationOptions as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </NativeSelect.Root>
  <label for={`${idPrefix}filter-status`} class="sr-only">状態</label>
  <NativeSelect.Root id={`${idPrefix}filter-status`} name="status" value={data.filters.status} class={selectClass}>
    <option value="">すべての状態</option>
    {#each data.statusOptions as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </NativeSelect.Root>
  <Button type="submit" variant="outline">絞り込む</Button>
  <Button variant="ghost" class="text-text-4" href={`${DASHBOARD_PATH}/audit`}>リセット</Button>
{/snippet}

<PageHeader title="Notion 書き込み履歴" />
<ActionFeedback result={data.error ? { kind: "error", message: data.error } : null} />

<details class="filter-disclosure">
  <summary class="filter-summary">
    <ListFilterIcon class="size-4" />
    絞り込み
    {#if activeFilters > 0}<span class="filter-count" aria-label={`${activeFilters} 件適用中`}>{activeFilters}</span>{/if}
    <ChevronDownIcon class="filter-chevron size-4" />
  </summary>
  <form class="filter-stack" method="get" action={`${DASHBOARD_PATH}/audit`}>
    {@render filterFields("m-", "w-full")}
  </form>
</details>
<form class="filter-bar" method="get" action={`${DASHBOARD_PATH}/audit`}>
  {@render filterFields("", "")}
</form>

<div class="table-wrap">
  <AuditList rows={data.rows} empty="該当する記録はありません。" />
  <Table.Root class="data-table table-roomy table-hover audit-table">
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
          <Table.Cell>{#if row.badge}<ToneBadge badge={row.badge} />{/if}</Table.Cell>
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
