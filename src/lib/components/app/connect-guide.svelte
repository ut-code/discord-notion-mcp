<script lang="ts">
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import * as Alert from "$lib/components/ui/alert";
  import { m } from "$lib/paraglide/messages.js";
  import CopyButton from "./copy-button.svelte";
  import ExternalLink from "./external-link.svelte";

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

{@render command(mcpUrl, m.connect_copy_url())}
<section class="stack min-w-0 gap-2" aria-labelledby="claude-code">
  <svelte:element this={heading} id="claude-code" class="text-sm font-semibold">Claude Code</svelte:element>
  {#each claude as text (text)}{@render command(text, m.connect_copy_command())}{/each}
  <p class="text-note text-muted-foreground">
    {m.connect_claude_code_login_before()} <code class="mono text-foreground">/mcp</code>
    {m.connect_claude_code_login_after()}
  </p>
</section>
<section class="stack min-w-0 gap-2" aria-labelledby="codex">
  <svelte:element this={heading} id="codex" class="text-sm font-semibold">Codex</svelte:element>
  {#each codex as text (text)}{@render command(text, m.connect_copy_command())}{/each}
</section>
<Alert.Root class="rounded-lg border-warn-border bg-warn-bg p-3.5 *:[svg]:text-warn-icon">
  <TriangleAlertIcon />
  <Alert.Title class="text-note font-semibold text-warn-text">{m.connect_training_title()}</Alert.Title>
  <Alert.Description class="stack gap-1.5 text-note [word-break:auto-phrase] text-warn-fg">
    <span>{m.connect_training_note()}</span>
    <span class="cluster gap-x-4">
      <ExternalLink href="https://claude.ai/settings/data-privacy-controls">{m.connect_training_claude()}</ExternalLink>
      <ExternalLink href="https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt">{m.connect_training_chatgpt()}</ExternalLink
      >
    </span>
  </Alert.Description>
</Alert.Root>
