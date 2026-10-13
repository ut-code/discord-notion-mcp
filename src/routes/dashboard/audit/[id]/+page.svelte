<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import ExternalLink from "$lib/components/app/external-link.svelte";
  import StatusBadges from "$lib/components/app/status-badges.svelte";
  import { DASHBOARD_PATH } from "$lib/paths";
  import RevertCard from "./revert-card.svelte";

  let { data, form } = $props();

  const change = $derived(data.change);
  const details = $derived(data.details);
</script>

<svelte:head>
  <title>#{data.id} {data.operation} — MCP</title>
</svelte:head>

<div class="stack gap-3">
  <a
    class="inline-flex items-center gap-1.5 self-start text-[13px] text-text-4 no-underline hover:text-foreground"
    href={`${DASHBOARD_PATH}/audit`}
  >
    <ChevronLeftIcon class="size-3.5" />
    書き込み履歴
  </a>
  <header class="cluster gap-3">
    <h1><span class="font-medium text-muted-foreground">#{data.id}</span> {data.operation}</h1>
    <StatusBadges badges={data.badges} />
  </header>
  <p class="text-muted-foreground">{data.summary}</p>
</div>

<div class="columns">
  <div class="col-main">
    <section class="panel panel-clip" aria-labelledby="change-heading">
      <div class="panel-head">
        <h2 id="change-heading">変更内容</h2>
        {#if (change.kind === "diff" || change.kind === "properties") && change.meta}<span class="mono">{change.meta}</span>{/if}
      </div>
      {#if change.kind === "diff"}
        {#if change.lines.length > 0}
          <div class="diff">
            {#each change.lines as line, index (index)}<span class={line.kind}>{line.text}</span>{/each}
          </div>
        {:else}
          <div class="change-body text-muted-foreground">ページの内容は変わりませんでした。</div>
        {/if}
      {:else if change.kind === "properties"}
        <div class="change-body">
          {#each change.entries as entry (entry.name)}
            <div class="prop">
              <span class="prop-name">{entry.name}</span>
              <span class="prop-old">{entry.before}</span>
              <ChevronRightIcon class="size-3.5" />
              <span class="prop-new">{entry.after}</span>
            </div>
          {:else}
            <span class="text-muted-foreground">記録された変更はありません。</span>
          {/each}
        </div>
      {:else if change.kind === "created"}
        <div class="change-body">
          <span class="cluster">
            ページを作成:
            {#if change.targetUrl}<ExternalLink href={change.targetUrl}>{change.title}</ExternalLink>{:else}<span>{change.title}</span>{/if}
          </span>
        </div>
      {:else if change.kind === "archived"}
        <div class="change-body">ページをゴミ箱に移動</div>
      {:else}
        <div class="change-body">
          {#if change.of}
            <span><a href={change.of.href}>#{change.of.id}</a> の取り消し</span>
          {:else}
            取り消し
          {/if}
        </div>
      {/if}
    </section>

    <section class="panel panel-pad" aria-labelledby="details-heading">
      <h2 id="details-heading">詳細</h2>
      <dl class="fields">
        <dt>ユーザー</dt>
        <dd class="flex flex-wrap items-center gap-2">
          <AppAvatar name={details.userName} url={details.avatarUrl} size="sm" />
          {details.userName}
          {#if details.username}<span class="mono">@{details.username}</span>{/if}
        </dd>
        <dt>対象ページ</dt>
        <dd>
          {#if details.targetUrl}<ExternalLink href={details.targetUrl}>{details.title}</ExternalLink>{:else}{details.title}{/if}
        </dd>
        <dt>日時</dt>
        <dd>{details.createdAt}</dd>
        <dt>Notion コメント</dt>
        <dd>
          {#if details.comment.kind === "error"}
            <span class="text-bad-fg">{details.comment.text}</span>
          {:else if details.comment.kind === "posted"}
            <span class="inline-flex items-center gap-1.5 text-ok-fg"><CheckIcon class="size-4" />投稿済み</span>
          {:else}
            <span class="text-muted-foreground">—</span>
          {/if}
        </dd>
        {#if details.error}
          <dt>{details.error.label}</dt>
          <dd class={details.error.failed ? "text-bad-fg" : undefined}>{details.error.text}</dd>
        {/if}
      </dl>
    </section>
  </div>
  {#if data.revert}
    <RevertCard revert={data.revert} conflict={Boolean(form?.conflict)} targetUrl={details.targetUrl} />
  {/if}
</div>
