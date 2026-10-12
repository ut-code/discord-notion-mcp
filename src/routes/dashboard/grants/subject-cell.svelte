<script lang="ts">
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import type { SubjectView } from "$lib/server/dashboard/grants";

  let { subject }: { subject: SubjectView } = $props();
</script>

<div class="cell-subject" title={subject.title ?? undefined}>
  {#if subject.kind === "role"}
    <span class="bg-muted inline-flex size-7 shrink-0 items-center justify-center rounded-full" aria-hidden="true">
      <span class="dot" style:background={subject.color ?? undefined}></span>
    </span>
  {:else}
    <AppAvatar name={subject.unknown ? "?" : subject.name} url={subject.avatarUrl} size="md" />
  {/if}
  <div class="stack">
    <span class={subject.unknown ? "mono text-foreground font-medium" : "font-medium"}>{subject.name}</span>
    <span class="mono">{subject.secondary}</span>
  </div>
</div>
