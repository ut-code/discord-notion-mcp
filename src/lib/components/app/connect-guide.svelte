<script lang="ts">
  import CopyButton from "./copy-button.svelte";

  let { mcpUrl, heading = "h2" }: { mcpUrl: string; heading?: "h2" | "h3" } = $props();

  const claude = $derived([`claude mcp add --transport http --scope user discord-notion ${mcpUrl}`]);
  const codex = $derived([`codex mcp add discord-notion --url ${mcpUrl}`, "codex mcp login discord-notion"]);
</script>

{#snippet command(text: string, label: string)}
  <div class="flex min-w-0 items-start gap-2">
    <!-- Wrap only between words: a line break after "--" would misquote an option. -->
    <code class="code-box code-wrap"
      >{#each text.split(" ") as word, index (index)}{index > 0 ? " " : ""}<span class="whitespace-nowrap">{word}</span>{/each}</code
    >
    <CopyButton {text} {label} />
  </div>
{/snippet}

{@render command(mcpUrl, "URL をコピー")}
<section class="stack min-w-0 gap-2" aria-labelledby="claude-code">
  <svelte:element this={heading} id="claude-code" class="text-sm font-semibold">Claude Code</svelte:element>
  {#each claude as text (text)}{@render command(text, "コマンドをコピー")}{/each}
  <p class="text-[13px] text-muted-foreground">Claude Code で <code class="mono text-foreground">/mcp</code> を開いてログイン</p>
</section>
<section class="stack min-w-0 gap-2" aria-labelledby="codex">
  <svelte:element this={heading} id="codex" class="text-sm font-semibold">Codex</svelte:element>
  {#each codex as text (text)}{@render command(text, "コマンドをコピー")}{/each}
</section>
