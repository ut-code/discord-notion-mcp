<script lang="ts">
  import type { AuditRowView } from "$lib/server/dashboard/audit";
  import ToneBadge from "./tone-badge.svelte";

  /** Compact write-history list shown on phones in place of the table. */
  let { rows, empty }: { rows: AuditRowView[]; empty: string } = $props();
</script>

<div class="audit-list">
  {#if rows.length > 0}
    <ul>
      {#each rows as row (row.id)}
        <li>
          <a class="audit-item" href={row.href}>
            <span class="audit-item-head">
              <span class="audit-item-title">{row.title}</span>
              {#if row.badge}<ToneBadge badge={row.badge} />{/if}
            </span>
            <span class="audit-item-meta">{row.meta}</span>
          </a>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="audit-list-empty">{empty}</p>
  {/if}
</div>
