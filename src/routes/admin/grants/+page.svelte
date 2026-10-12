<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import LockIcon from "@lucide/svelte/icons/lock";
  import SearchIcon from "@lucide/svelte/icons/search";
  import TrashIcon from "@lucide/svelte/icons/trash";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { actionUrl } from "$lib/action-url";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import ToneBadge from "$lib/components/app/tone-badge.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import * as Table from "$lib/components/ui/table";
  import { grantSubmitLabel } from "$lib/grant-label";
  import { ADMIN_PATH } from "$lib/paths";
  import SubjectCell from "./subject-cell.svelte";

  let { data } = $props();

  // Form state follows the server data (e.g. after a member search) and the user's choices.
  let permission = $derived(data.form.permission);
  let subjectType = $derived(data.form.subjectType);
  let roleId = $derived(data.form.roleId);
  let userId = $derived(data.form.selectedUserId ?? "");

  const permissionOption = $derived(data.form.permissions.find((option) => option.value === permission) ?? data.form.permissions[0]!);
  const target = $derived(
    subjectType === "role"
      ? (data.form.roles.find((role) => role.id === roleId)?.handle ?? null)
      : (data.form.candidates.find((candidate) => candidate.id === userId)?.name ?? null),
  );
  const submitLabel = $derived(grantSubmitLabel(permissionOption.label, target));
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
            <Table.Head class="actions"><span class="sr-only">操作</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.rows as row (row.key)}
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
              <Table.Cell class="actions">
                {#if row.remove}
                  <form method="post" action={actionUrl(page.url, "delete")} use:enhance class="inline">
                    <input type="hidden" name="permission" value={row.remove.permission} />
                    <input type="hidden" name="subjectType" value={row.remove.subjectType} />
                    <input type="hidden" name="subjectId" value={row.remove.subjectId} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:bg-bad-bg hover:text-bad-fg"
                      aria-label={row.remove.label}
                      title="削除"
                    >
                      <TrashIcon />
                    </Button>
                  </form>
                {:else if row.locked}
                  <span class="text-subtle inline-flex w-8 justify-center" title={row.locked}>
                    <LockIcon class="size-4" role="img" aria-label="削除不可" />
                  </span>
                {/if}
              </Table.Cell>
            </Table.Row>
          {:else}
            <Table.Row>
              <Table.Cell class="empty" colspan={5}>付与はありません。</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  </section>

  <section class="panel panel-pad col-side gap-[18px]" aria-labelledby="add-grant">
    <h2 id="add-grant">権限を付与</h2>
    <form class="grant-form flex flex-col gap-[18px]" method="post" action={actionUrl(page.url, "create")} use:enhance>
      {#if data.filter}<input type="hidden" name="filter" value={data.filter} />{/if}
      <div class="flex flex-col gap-2">
        <Label for="grant-permission">権限</Label>
        <NativeSelect.Root id="grant-permission" name="permission" class="w-full" aria-describedby="grant-hint" bind:value={permission}>
          {#each data.form.permissions as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </NativeSelect.Root>
        <span class="text-muted-foreground text-xs" id="grant-hint">{permissionOption.hint}</span>
      </div>

      <fieldset class="m-0 min-w-0 border-0 p-0">
        <legend class="mb-2 p-0 text-sm font-medium">対象</legend>
        <div class="segmented">
          <label>
            <input type="radio" id="target-role" name="subjectType" value="role" bind:group={subjectType} />
            <span class="link-tab">ロール</span>
          </label>
          <label>
            <input type="radio" id="target-user" name="subjectType" value="user" bind:group={subjectType} />
            <span class="link-tab">ユーザー</span>
          </label>
        </div>
      </fieldset>

      <div class="only-role flex flex-col gap-2">
        <Label for="grant-role">ロール</Label>
        <NativeSelect.Root id="grant-role" name="roleId" class="w-full" bind:value={roleId}>
          {#each data.form.roles as role (role.id)}
            <option value={role.id}>{role.name}</option>
          {/each}
        </NativeSelect.Root>
      </div>

      <div class="only-user flex flex-col gap-2">
        <Label for="grant-q">メンバーを検索</Label>
        <div class="search">
          <button class="search-icon" type="submit" formmethod="get" formaction={`${ADMIN_PATH}/grants`} formnovalidate aria-label="検索">
            <SearchIcon class="size-4" />
          </button>
          <Input id="grant-q" name="q" type="search" value={data.form.query} autocomplete="off" placeholder="名前・@ユーザー名・ID" />
        </div>
        {#if data.form.searchError}
          <div class="picker"><p class="text-bad-fg px-2 py-2.5 text-[13px]">{data.form.searchError}</p></div>
        {:else if data.form.candidates.length > 0}
          <div class="picker" role="radiogroup" aria-label="付与するユーザー">
            {#each data.form.candidates as user (user.id)}
              <label class="pick">
                <input type="radio" name="userId" value={user.id} bind:group={userId} />
                <AppAvatar name={user.name} url={user.avatarUrl} size="md" />
                <span class="stack">
                  <span class="text-sm font-medium">{user.name}</span>
                  <span class="mono">{user.secondLine}</span>
                </span>
                <span class="pick-check"><CheckIcon class="size-4" /></span>
              </label>
            {/each}
          </div>
        {:else if data.form.query}
          <div class="picker"><p class="text-muted-foreground px-2 py-2.5 text-[13px]">「{data.form.query}」に一致するメンバーはいません。</p></div>
        {/if}
      </div>

      <Button type="submit" class="w-full">{submitLabel}</Button>
    </form>
  </section>
</div>
