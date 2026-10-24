<script lang="ts">
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import ActionFeedback from "#lib/components/app/action-feedback.svelte";
  import AppAvatar from "#lib/components/app/app-avatar.svelte";
  import AuditList from "#lib/components/app/audit-list.svelte";
  import ExternalLink from "#lib/components/app/external-link.svelte";
  import FilterPanel, { type FilterField } from "#lib/components/app/filter-panel.svelte";
  import HistoryTabs from "#lib/components/app/history-tabs.svelte";
  import PageHeader from "#lib/components/app/page-header.svelte";
  import Pager from "#lib/components/app/pager.svelte";
  import ToneBadge from "#lib/components/app/tone-badge.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import { m } from "#lib/paraglide/messages.js";
  import { AUDIT_PATH } from "#lib/paths.js";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  // Shares of the table width (see .history-table): #, time, user, operation, page, status, details.
  const columns = ["6%", "13%", "17%", "17%", "28%", "13%", "6%"];

  const fields = $derived<FilterField[]>([
    ...(data.canFilterUsers
      ? [{ name: "user", label: m.common_user(), value: data.filters.user, allLabel: m.filter_all_users(), options: data.userOptions }]
      : []),
    {
      name: "operation",
      label: m.audit_operation(),
      value: data.filters.operation,
      allLabel: m.audit_filter_all_operations(),
      options: data.operationOptions,
    },
    {
      name: "status",
      label: m.common_status(),
      value: data.filters.status,
      allLabel: m.filter_all_statuses(),
      options: data.statusOptions,
    },
  ]);
</script>

<PageHeader title={m.history_title()} />
<HistoryTabs tabs={data.tabs} />
<ActionFeedback result={data.error ? { kind: "error", message: data.error } : null} />
<FilterPanel action={AUDIT_PATH} {fields} resetHref={AUDIT_PATH} />

<div class="table-wrap history-wrap">
  <AuditList rows={data.rows} empty={m.audit_empty()} />
  <Table.Root class="data-table table-roomy table-hover history-table">
    <colgroup>
      {#each columns as share, index (index)}<col style:--share={share} />{/each}
    </colgroup>
    <Table.Header>
      <Table.Row>
        <Table.Head>#</Table.Head>
        <Table.Head>{m.audit_time()}</Table.Head>
        <Table.Head>{m.common_user()}</Table.Head>
        <Table.Head>{m.audit_operation()}</Table.Head>
        <Table.Head>{m.audit_target_page()}</Table.Head>
        <Table.Head>{m.common_status()}</Table.Head>
        <Table.Head class="actions"><span class="sr-only">{m.audit_details()}</span></Table.Head>
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
              <span class="scroll-x">{row.user.name}</span>
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
          <Table.Cell><ToneBadge badge={row.status} /></Table.Cell>
          <Table.Cell class="actions">
            <Button variant="ghost" size="icon-sm" href={row.href} aria-label={m.audit_row_details({ id: row.id })}
              ><ChevronRightIcon /></Button
            >
          </Table.Cell>
        </Table.Row>
      {:else}
        <Table.Row>
          <Table.Cell class="empty" colspan={columns.length}>{m.audit_empty()}</Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>

{#if data.range || data.prevHref}
  <div class="footer-row">
    <span class="text-note text-muted-foreground">{data.range ?? ""}</span>
    <Pager prev={data.prevHref} next={data.nextHref} />
  </div>
{/if}
