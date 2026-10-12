<script lang="ts">
  import EyeIcon from "@lucide/svelte/icons/eye";
  import FileTextIcon from "@lucide/svelte/icons/file";
  import PenLineIcon from "@lucide/svelte/icons/pen-line";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import AuthLayout from "$lib/components/app/auth-layout.svelte";
  import { Button } from "$lib/components/ui/button";
  import { SIGN_OUT_PATH } from "$lib/paths";

  let { data } = $props();

  const ICONS = { "discord:read": EyeIcon, "notion:read": FileTextIcon, "notion:write": PenLineIcon, admin: SettingsIcon };

  let busy = $state(false);
  let status = $state("");

  async function decide(accept: boolean) {
    busy = true;
    status = "";
    try {
      const res = await fetch(data.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ accept, oauth_query: data.oauthQuery }),
      });
      const result = await res.json().catch(() => ({}));
      const target = result.url || result.redirect_uri;
      if (res.ok && target) {
        window.location.href = target;
        return;
      }
      throw new Error(result.message || result.error_description || "処理できませんでした。もう一度お試しください。");
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      busy = false;
    }
  }
</script>

<AuthLayout title="アクセスの許可 — Discord × Notion MCP" wide>
  <section class="auth-card">
    <div class="stack gap-2">
      <h1><span>{data.clientName}</span> がアクセスを求めています</h1>
      <p class="lead">許可すると、このアプリがあなたの権限の範囲で MCP ツールを使えるようになります。</p>
    </div>

    <div class="flex items-center gap-3 rounded-[10px] border p-3">
      <AppAvatar name={data.account.name} url={data.account.avatarUrl} size="lg" />
      <div class="stack grow">
        <span class="truncate text-sm font-medium">{data.account.name}</span>
        <span class="mono">@{data.account.username} · {data.guildName}</span>
      </div>
      <form method="post" action={SIGN_OUT_PATH}>
        <input type="hidden" name="next" value={data.switchNext} />
        <button class="text-text-4 hover:text-foreground cursor-pointer text-[13px] underline" type="submit">切り替え</button>
      </form>
    </div>

    <div class="flex flex-col">
      <span class="text-text-4 mb-1 text-[13px] font-medium">使えるようになる機能</span>
      {#if data.features.length === 0}
        <p class="text-muted-foreground py-3 text-[13px]">まだ権限が付与されていません。管理者に依頼してください。</p>
      {:else}
        {#each data.features as feature (feature.permission)}
          {@const Icon = ICONS[feature.permission]}
          <div class="border-muted flex items-start gap-3 border-b py-3 last:border-b-0">
            <Icon class="text-foreground mt-0.5 size-4 shrink-0" />
            <div class="stack">
              <span class="text-sm font-medium">{feature.title}</span>
              <span class="text-muted-foreground text-[13px]">{feature.description}</span>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="grid grid-cols-2 gap-2">
      <Button variant="outline" size="lg" disabled={busy} onclick={() => decide(false)}>拒否</Button>
      <Button size="lg" disabled={busy} onclick={() => decide(true)}>許可する</Button>
    </div>
    {#if status}
      <p class="text-bad-fg text-[13px]" role="status">{status}</p>
    {/if}
  </section>
  <p class="text-muted-foreground text-center text-xs leading-relaxed">自分で接続していない場合は拒否してください。</p>
</AuthLayout>
