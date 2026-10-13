<script lang="ts">
  import AuthLayout from "$lib/components/app/auth-layout.svelte";
  import CopyButton from "$lib/components/app/copy-button.svelte";

  let { data } = $props();

  const claude = $derived([`claude mcp add --transport http --scope user discord-notion ${data.mcpUrl}`]);
  const codex = $derived([`codex mcp add discord-notion --url ${data.mcpUrl}`, "codex mcp login discord-notion"]);
</script>

{#snippet command(text: string, label: string)}
  <div class="flex items-start gap-2">
    <!-- Wrap only between words: a line break after "--" would misquote an option. -->
    <code class="code-box code-wrap"
      >{#each text.split(" ") as word, index (index)}{index > 0 ? " " : ""}<span class="whitespace-nowrap">{word}</span>{/each}</code
    >
    <CopyButton {text} {label} />
  </div>
{/snippet}

<AuthLayout title="接続方法 — Discord × Notion MCP" wide>
  <section class="auth-card">
    <h1>接続方法</h1>
    {@render command(data.mcpUrl, "URL をコピー")}
    <section class="stack gap-2" aria-labelledby="claude-code">
      <h2 id="claude-code" class="text-sm">Claude Code</h2>
      {#each claude as text (text)}{@render command(text, "コマンドをコピー")}{/each}
      <p class="text-[13px] text-muted-foreground">Claude Code で <code class="mono text-foreground">/mcp</code> を開いてログイン</p>
    </section>
    <section class="stack gap-2" aria-labelledby="codex">
      <h2 id="codex" class="text-sm">Codex</h2>
      {#each codex as text (text)}{@render command(text, "コマンドをコピー")}{/each}
    </section>
  </section>
</AuthLayout>
