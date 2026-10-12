<script lang="ts">
  import SearchIcon from "@lucide/svelte/icons/search";
  import UserIcon from "@lucide/svelte/icons/user";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import Pager from "$lib/components/app/pager.svelte";
  import ToneBadge from "$lib/components/app/tone-badge.svelte";
  import { Input } from "$lib/components/ui/input";
  import * as Table from "$lib/components/ui/table";
  import { DASHBOARD_PATH } from "$lib/paths";
  import UserMenu from "./user-menu.svelte";

  let { data } = $props();
</script>

<PageHeader title="ユーザー" />

<div class="footer-row">
  <form class="search min-w-[220px] flex-[0_1_320px]" method="get" action={`${DASHBOARD_PATH}/users`} role="search">
    <button class="search-icon" type="submit" aria-label="検索"><SearchIcon class="size-4" /></button>
    <label for="user-q" class="sr-only">ユーザーを検索</label>
    <Input id="user-q" name="q" type="search" value={data.query} placeholder="名前・@ユーザー名・ID で検索" autocomplete="off" />
  </form>
  <span class="text-muted-foreground text-[13px]">{data.total} 人</span>
</div>

<div class="table-wrap">
  <Table.Root class="data-table table-tall">
    <Table.Header>
      <Table.Row>
        <Table.Head>ユーザー</Table.Head>
        <Table.Head>権限</Table.Head>
        <Table.Head>最終ログイン</Table.Head>
        <Table.Head class="actions"><span class="sr-only">操作</span></Table.Head>
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
