<script lang="ts">
  import LockIcon from "@lucide/svelte/icons/lock";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import ToneBadge from "$lib/components/app/tone-badge.svelte";
  import * as Table from "$lib/components/ui/table";
  import { m } from "$lib/paraglide/messages.js";
  import GrantForm from "./grant-form.svelte";
  import GrantMenu from "./grant-menu.svelte";
  import SubjectCell from "./subject-cell.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<PageHeader title={m.grants_title()} />

<div class="columns">
  <section class="col-main gap-3" aria-label={m.grants_list_label()}>
    <nav class="link-tabs" aria-label={m.grants_filter_label()}>
      {#each data.tabs as tab (tab.href)}
        <a class="link-tab" href={tab.href} aria-current={tab.active ? "page" : undefined}>
          {tab.label}
          {#if tab.count !== null}<span class="mono text-muted-foreground">{tab.count}</span>{/if}
        </a>
      {/each}
    </nav>
    <div class="table-wrap">
      <Table.Root class="data-table table-roomy">
        <Table.Header>
          <Table.Row>
            <Table.Head>{m.grants_subject()}</Table.Head>
            <Table.Head>{m.common_permission()}</Table.Head>
            <Table.Head>{m.grants_granted_at()}</Table.Head>
            <Table.Head class="actions"><span class="sr-only">{m.common_actions()}</span></Table.Head>
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
              <Table.Cell class={row.locked ? "muted" : "secondary"}>{row.grantedAt}</Table.Cell>
              <Table.Cell class="actions">
                {#if row.remove}
                  <GrantMenu remove={row.remove} {index} />
                {:else if row.locked}
                  <span class="inline-flex w-8 justify-center text-subtle" title={row.locked}>
                    <LockIcon class="size-4" role="img" aria-label={m.grants_locked_icon()} />
                  </span>
                {/if}
              </Table.Cell>
            </Table.Row>
          {:else}
            <Table.Row>
              <Table.Cell class="empty" colspan={4}>{m.grants_empty()}</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  </section>

  <GrantForm form={data.form} filter={data.filter} />
</div>
