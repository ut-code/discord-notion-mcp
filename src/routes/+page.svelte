<script lang="ts">
  import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
  import AuthLayout from "$lib/components/app/auth-layout.svelte";
  import ConnectGuide from "$lib/components/app/connect-guide.svelte";
  import { Button } from "$lib/components/ui/button";
  import { m } from "$lib/paraglide/messages.js";
  import { DASHBOARD_PATH } from "$lib/paths";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<AuthLayout title={`${m.connect_title()} — Discord × Notion MCP`} wide>
  <section class="auth-card">
    <h1>{m.connect_title()}</h1>
    <ConnectGuide mcpUrl={data.mcpUrl} />
  </section>
  <Button variant="ghost" class="self-center text-muted-foreground" href={DASHBOARD_PATH}>
    {m.connect_dashboard_link()}
    <ArrowRightIcon />
  </Button>
</AuthLayout>
