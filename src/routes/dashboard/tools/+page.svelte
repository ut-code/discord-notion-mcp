<script lang="ts">
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import LockIcon from "@lucide/svelte/icons/lock";
  import { onMount } from "svelte";
  import PageHeader from "#lib/components/app/page-header.svelte";
  import ToneBadge from "#lib/components/app/tone-badge.svelte";
  import { formatNumber } from "#lib/locale.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  // A link to `#<tool name>` scrolls to the tool; a <details> does not open for its fragment by itself.
  // Tool names are plain ASCII, so the fragment is used as it is (decoding could throw on a bad one).
  onMount(() => {
    const openLinked = () => {
      const target = document.getElementById(location.hash.slice(1));
      if (target instanceof HTMLDetailsElement) target.open = true;
    };
    openLinked();
    window.addEventListener("hashchange", openLinked);
    return () => window.removeEventListener("hashchange", openLinked);
  });
</script>

<PageHeader title={m.tools_title()} />

<!-- What the Discord tools can read for the viewer: a disclosure under their heading, since it qualifies them. -->
{#snippet channels()}
  {#if data.channels?.kind === "error"}
    <p class="text-note text-bad-fg" role="status">{data.channels.message}</p>
  {:else if data.channels}
    {@const view = data.channels.view}
    <details class="channel-disclosure" id="discord-channels">
      <summary class="channel-summary">
        {m.tools_channels_title()}
        <ToneBadge badge={{ label: formatNumber(view.accessibleCount), tone: "secondary" }} />
        <ChevronDownIcon class="tool-chevron size-4" />
      </summary>
      <div class="panel">
        {#each view.categories as category (category.id)}
          <div class="channel-group">
            <h3>{category.name ?? m.tools_channels_no_category()}</h3>
            <ul class="channel-chips">
              {#each category.channels as channel (channel.id)}
                <li>
                  <a
                    class={["channel-chip", !channel.botCanRead && "botless"]}
                    href={channel.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={channel.botCanRead ? undefined : m.tools_channels_botless()}
                  >
                    {#if !channel.botCanRead}<LockIcon class="size-3" /><span class="sr-only">{m.tools_channels_botless()}</span
                      >{/if}#{channel.name}
                  </a>
                </li>
              {/each}
            </ul>
          </div>
        {:else}
          <p class="channel-group text-note text-muted-foreground">{m.tools_channels_none()}</p>
        {/each}
      </div>
      {#if view.botlessCount > 0}
        <p class="channel-legend"><LockIcon class="size-3" />{m.tools_channels_botless()}</p>
      {/if}
    </details>
  {/if}
{/snippet}

{#each data.groups as group (group.permission)}
  <section class="stack gap-3" aria-labelledby={`tools-${group.permission}`}>
    <h2 id={`tools-${group.permission}`} class="cluster">
      {group.label}
      {#if !group.available}<ToneBadge badge={{ label: m.tools_unavailable(), tone: "secondary" }} />{/if}
    </h2>
    {#if !group.available}<p class="text-note text-muted-foreground">{m.tools_unavailable_note()}</p>{/if}
    {#if group.permission === "discord:read"}{@render channels()}{/if}
    <div class="panel tool-list">
      {#each group.tools as tool (tool.name)}
        <details class="tool" id={tool.name}>
          <summary class="tool-summary">
            <span class="tool-names">
              <span class="tool-name mono">{tool.name}</span>
              <span class="tool-title">{tool.title}</span>
            </span>
            <ChevronDownIcon class="tool-chevron size-4" />
          </summary>
          <div class="tool-body">
            <p class="tool-description" lang="en">{tool.description}</p>
            <h3 class="tool-heading">{m.tools_parameters()}</h3>
            {#if tool.parameters.length > 0}
              <dl class="tool-params">
                {#each tool.parameters as parameter (parameter.name)}
                  <div>
                    <dt class="cluster">
                      <span class="mono text-foreground">{parameter.name}</span>
                      <span class="mono text-muted-foreground">{parameter.type}</span>
                      {#if parameter.required}<ToneBadge badge={{ label: m.tools_required(), tone: "outline" }} />{/if}
                    </dt>
                    <dd>
                      {#if parameter.description}<span lang="en">{parameter.description}</span>{/if}
                      {#if parameter.defaultValue !== null}
                        <span class="text-muted-foreground">{m.tools_default({ value: parameter.defaultValue })}</span>
                      {/if}
                    </dd>
                  </div>
                {/each}
              </dl>
            {:else}
              <p class="text-note text-muted-foreground">{m.tools_no_parameters()}</p>
            {/if}
            <details class="tool-schema">
              <summary>{m.tools_schema()}</summary>
              <pre class="mono">{tool.schema}</pre>
            </details>
          </div>
        </details>
      {/each}
    </div>
  </section>
{/each}
