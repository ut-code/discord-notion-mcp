<script lang="ts" module>
  import type { Option } from "#lib/server/dashboard/shared.js";

  export interface FilterField {
    name: string;
    /** Read out for the select; it shows `allLabel` when empty. */
    label: string;
    value: string;
    allLabel: string;
    options: Option[];
  }
</script>

<script lang="ts">
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ListFilterIcon from "@lucide/svelte/icons/list-filter";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as NativeSelect from "#lib/components/ui/native-select/index.js";
  import { goto } from "$app/navigation";
  import { formatNumber } from "#lib/locale.js";
  import { m } from "#lib/paraglide/messages.js";

  let {
    action,
    fields,
    hidden = {},
    resetHref,
  }: {
    /** The list page the filters are query parameters of. */
    action: string;
    fields: FilterField[];
    /** Parameters kept as they are, e.g. the history tab. */
    hidden?: Record<string, string>;
    resetHref: string;
  } = $props();

  const active = $derived(fields.filter((field) => field.value !== "").length);

  /** Applies a changed filter right away (the submit button is the no-JavaScript path). */
  function apply(event: Event & { currentTarget: HTMLFormElement }) {
    const filled = [...new FormData(event.currentTarget)].filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    );
    const query = new URLSearchParams(filled).toString();
    void goto(`${action}${query ? `?${query}` : ""}`, { reset: false });
  }
</script>

{#snippet controls(idPrefix: string, selectClass: string)}
  {#each Object.entries(hidden) as [name, value] (name)}
    <input type="hidden" {name} {value} />
  {/each}
  {#each fields as field (field.name)}
    <label for={`${idPrefix}filter-${field.name}`} class="sr-only">{field.label}</label>
    <NativeSelect.Root id={`${idPrefix}filter-${field.name}`} name={field.name} value={field.value} class={selectClass}>
      <option value="">{field.allLabel}</option>
      {#each field.options as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </NativeSelect.Root>
  {/each}
  <!-- With JavaScript the filters apply as they change. -->
  <noscript><Button type="submit" variant="outline">{m.filter_apply()}</Button></noscript>
  <Button variant="ghost" class="justify-self-start text-muted-foreground" href={resetHref}>{m.filter_reset()}</Button>
{/snippet}

<details class="filter-disclosure">
  <summary class="filter-summary">
    <ListFilterIcon class="size-4" />
    {m.filter_toggle()}
    {#if active > 0}
      <span class="filter-count" aria-label={m.filter_active_count({ count: formatNumber(active) })}>{formatNumber(active)}</span>
    {/if}
    <ChevronDownIcon class="filter-chevron size-4" />
  </summary>
  <form class="filter-stack" method="get" {action} onchange={apply}>
    {@render controls("m-", "w-full")}
  </form>
</details>
<form class="filter-bar" method="get" {action} onchange={apply}>
  {@render controls("", "")}
</form>
