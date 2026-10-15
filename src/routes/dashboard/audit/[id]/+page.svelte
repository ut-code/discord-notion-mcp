<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import ExternalLink from "$lib/components/app/external-link.svelte";
  import StatusBadges from "$lib/components/app/status-badges.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import { DASHBOARD_PATH } from "$lib/paths";
  import RevertCard from "./revert-card.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

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
    {m.audit_back_to_list()}
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
        <h2 id="change-heading">{m.audit_change_heading()}</h2>
        {#if (change.kind === "diff" || change.kind === "properties") && change.meta}<span class="mono">{change.meta}</span>{/if}
      </div>
      {#if change.kind === "diff"}
        {#if change.lines.length > 0}
          <div class="diff">
            {#each change.lines as line, index (index)}<span class={line.kind}>{line.text}</span>{/each}
          </div>
        {:else}
          <div class="change-body text-muted-foreground">{m.audit_change_unchanged()}</div>
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
            <span class="text-muted-foreground">{m.audit_change_none()}</span>
          {/each}
        </div>
      {:else if change.kind === "created"}
        <div class="change-body">
          <span class="cluster">
            {m.audit_change_created()}
            {#if change.targetUrl}<ExternalLink href={change.targetUrl}>{change.title}</ExternalLink>{:else}<span>{change.title}</span>{/if}
          </span>
        </div>
      {:else if change.kind === "archived"}
        <div class="change-body">{m.audit_change_archived()}</div>
      {:else}
        <div class="change-body">
          {#if change.of}
            <span><a href={change.of.href}>#{change.of.id}</a> {m.audit_change_revert_of()}</span>
          {:else}
            {m.operation_revert()}
          {/if}
        </div>
      {/if}
    </section>

    <section class="panel panel-pad" aria-labelledby="details-heading">
      <h2 id="details-heading">{m.audit_details()}</h2>
      <dl class="fields">
        <dt>{m.common_user()}</dt>
        <dd class="flex flex-wrap items-center gap-2">
          <AppAvatar name={details.userName} url={details.avatarUrl} size="sm" />
          {details.userName}
          {#if details.username}<span class="mono">@{details.username}</span>{/if}
        </dd>
        <dt>{m.audit_target_page()}</dt>
        <dd>
          {#if details.targetUrl}<ExternalLink href={details.targetUrl}>{details.title}</ExternalLink>{:else}{details.title}{/if}
        </dd>
        <dt>{m.audit_time()}</dt>
        <dd>{details.createdAt}</dd>
        <dt>{m.audit_notion_comment()}</dt>
        <dd>
          {#if details.comment.kind === "error"}
            <span class="text-bad-fg">{details.comment.text}</span>
          {:else if details.comment.kind === "posted"}
            <span class="inline-flex items-center gap-1.5 text-ok-fg"><CheckIcon class="size-4" />{m.audit_comment_posted()}</span>
          {:else}
            <span class="text-muted-foreground">—</span>
          {/if}
        </dd>
        {#if details.error}
          <dt>{m.audit_error_label()}</dt>
          <dd class="text-bad-fg">{details.error}</dd>
        {/if}
        {#if details.note}
          <dt>{m.audit_note_label()}</dt>
          <dd>{details.note}</dd>
        {/if}
      </dl>
    </section>
  </div>
  {#if data.revert}
    <RevertCard revert={data.revert} conflict={Boolean(form?.conflict)} targetUrl={details.targetUrl} />
  {/if}
</div>
