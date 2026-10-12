<script lang="ts">
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import { page } from "$app/state";
  import AuthLayout from "$lib/components/app/auth-layout.svelte";
  import { Button } from "$lib/components/ui/button";
  import { SIGN_OUT_PATH } from "$lib/paths";

  const DEFAULT_TITLES: Record<number, string> = { 400: "無効なリクエスト", 403: "アクセスできません", 404: "見つかりません" };

  const title = $derived(page.error?.title ?? DEFAULT_TITLES[page.status] ?? "エラー");
  const message = $derived(page.status === 404 && !page.error?.title ? "ページが見つかりません。" : (page.error?.message ?? ""));
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
          ログアウト
        </Button>
      </form>
    {/if}
  </section>
</AuthLayout>
