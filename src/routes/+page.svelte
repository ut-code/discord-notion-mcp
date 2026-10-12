<script lang="ts">
  import AuthLayout from "$lib/components/app/auth-layout.svelte";

  let { data } = $props();
</script>

<AuthLayout title="Discord × Notion MCP">
  <section class="auth-card">
    <div class="stack gap-2">
      <h1>Discord × Notion MCP</h1>
      <p class="lead">MCP クライアントにこの URL を登録してください。</p>
    </div>
    <code class="code-box">{data.mcpUrl}</code>
  </section>
</AuthLayout>
