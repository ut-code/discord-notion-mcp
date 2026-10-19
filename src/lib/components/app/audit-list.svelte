<script lang="ts">
  import type { AuditRowView } from "#lib/server/dashboard/audit.js";
  import ToneBadge from "./tone-badge.svelte";

  /** Compact write-history list shown on phones in place of the table. */
  let { rows, empty }: { rows: AuditRowView[]; empty: string } = $props();
</script>

<div class="history-list">
  {#if rows.length > 0}
    <ul>
      {#each rows as row (row.id)}
        <li>
          <a class="history-item" href={row.href}>
            <span class="history-item-head">
              <span class="history-item-title">{row.title}</span>
              {#if row.badge}<ToneBadge badge={row.badge} />{/if}
            </span>
            <span class="history-item-meta">{row.meta}</span>
          </a>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="history-list-empty">{empty}</p>
  {/if}
</div>
