<script lang="ts">
  import LockIcon from "@lucide/svelte/icons/lock";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import ToneBadge from "$lib/components/app/tone-badge.svelte";
  import * as Table from "$lib/components/ui/table";
  import GrantForm from "./grant-form.svelte";
  import GrantMenu from "./grant-menu.svelte";
  import SubjectCell from "./subject-cell.svelte";

  let { data } = $props();

  const manage = $derived(data.form !== null);
</script>

<PageHeader title="権限" />

<div class="columns">
  <section class="col-main gap-3" aria-label="付与の一覧">
    <nav class="link-tabs" aria-label="権限で絞り込み">
      {#each data.tabs as tab (tab.href)}
        <a class="link-tab" href={tab.href} aria-current={tab.active ? "page" : undefined}>
          {tab.label}
          {#if tab.count !== null}<span class="mono text-text-4">{tab.count}</span>{/if}
        </a>
      {/each}
    </nav>
    <div class="table-wrap">
      <Table.Root class="data-table table-roomy">
        <Table.Header>
          <Table.Row>
            <Table.Head>対象</Table.Head>
            <Table.Head>権限</Table.Head>
            <Table.Head>付与者</Table.Head>
            <Table.Head>付与日</Table.Head>
            {#if manage}<Table.Head class="actions"><span class="sr-only">操作</span></Table.Head>{/if}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.rows as row, index (row.key)}
            <Table.Row>
              <Table.Cell class="primary"><SubjectCell subject={row.subject} /></Table.Cell>
              <Table.Cell>
                <span class="cluster">
                  <ToneBadge badge={{ label: row.permissionLabel, tone: "outline" }} />
                  {#if row.redundancy}<ToneBadge badge={row.redundancy} />{/if}
                </span>
              </Table.Cell>
              <Table.Cell class="secondary wrap">{row.grantedBy}</Table.Cell>
              <Table.Cell class={row.locked ? "muted" : "secondary"}>{row.grantedAt}</Table.Cell>
              {#if manage}
                <Table.Cell class="actions">
                  {#if row.remove}
                    <GrantMenu remove={row.remove} {index} />
                  {:else if row.locked}
                    <span class="text-subtle inline-flex w-8 justify-center" title={row.locked}>
                      <LockIcon class="size-4" role="img" aria-label="削除不可" />
                    </span>
                  {/if}
                </Table.Cell>
              {/if}
            </Table.Row>
          {:else}
            <Table.Row>
              <Table.Cell class="empty" colspan={manage ? 5 : 4}>付与はありません。</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  </section>

  {#if data.form}
    <GrantForm form={data.form} filter={data.filter} />
  {/if}
</div>
