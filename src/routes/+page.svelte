<script lang="ts">
  import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
  import AuthLayout from "$lib/components/app/auth-layout.svelte";
  import ConnectGuide from "$lib/components/app/connect-guide.svelte";
  import { Button } from "$lib/components/ui/button";
  import { DASHBOARD_PATH } from "$lib/paths";

  let { data } = $props();
</script>

<AuthLayout title="接続方法 — Discord × Notion MCP" wide>
  <section class="auth-card">
    <h1>接続方法</h1>
    <ConnectGuide mcpUrl={data.mcpUrl} />
  </section>
  <Button variant="ghost" class="self-center text-muted-foreground" href={DASHBOARD_PATH}>
    ダッシュボード
    <ArrowRightIcon />
  </Button>
</AuthLayout>
