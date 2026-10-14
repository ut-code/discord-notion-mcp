<script lang="ts">
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import { page } from "$app/state";
  import AuthLayout from "$lib/components/app/auth-layout.svelte";
  import { Button } from "$lib/components/ui/button";
  import { m } from "$lib/paraglide/messages.js";
  import { SIGN_OUT_PATH } from "$lib/paths";

  const DEFAULT_TITLES: Record<number, string> = { 400: m.error_title_400(), 403: m.access_denied_title(), 404: m.error_title_404() };

  const title = $derived(page.error?.title ?? DEFAULT_TITLES[page.status] ?? m.error_title_default());
  const message = $derived(page.status === 404 && !page.error?.title ? m.error_page_not_found() : (page.error?.message ?? ""));
  const suffix = $derived(page.error?.signedIn ? "MCP" : "Discord × Notion MCP");
</script>

<AuthLayout title={`${title} — ${suffix}`}>
  <section class="auth-card">
    <div class="stack gap-2">
      <h1>{title}</h1>
      <p class="lead">{message}</p>
    </div>
    {#if page.error?.signedIn}
      <form method="post" action={SIGN_OUT_PATH}>
        <Button type="submit" variant="outline" class="h-9 w-full">
          <LogOutIcon />
          {m.common_sign_out()}
        </Button>
      </form>
    {/if}
  </section>
</AuthLayout>
