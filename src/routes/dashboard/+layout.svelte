<script lang="ts">
  import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import PlugIcon from "@lucide/svelte/icons/plug";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import UsersIcon from "@lucide/svelte/icons/users";
  import { page } from "$app/state";
  import ActionFeedback from "$lib/components/app/action-feedback.svelte";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import ThemeToggle from "$lib/components/app/theme-toggle.svelte";
  import { Button } from "$lib/components/ui/button";
  import { initialOf } from "$lib/initial";
  import { CONNECT_PATH, DASHBOARD_PATH, SIGN_OUT_PATH } from "$lib/paths";

  let { data, children } = $props();

  const nav = $derived([
    { href: DASHBOARD_PATH, label: "概要", icon: LayoutDashboardIcon },
    { href: `${DASHBOARD_PATH}/stats`, label: "統計", icon: ChartColumnIcon },
    { href: `${DASHBOARD_PATH}/grants`, label: "権限", icon: ShieldIcon },
    { href: `${DASHBOARD_PATH}/users`, label: "ユーザー", icon: UsersIcon },
    ...(data.viewer.canViewAudit ? [{ href: `${DASHBOARD_PATH}/audit`, label: "Notion 書き込み履歴", icon: HistoryIcon }] : []),
  ]);

  const isActive = (href: string) => (href === DASHBOARD_PATH ? page.url.pathname === DASHBOARD_PATH : page.url.pathname.startsWith(href));
</script>

<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo" aria-hidden="true">{initialOf(data.viewer.guildName)}</div>
      <div class="stack">
        <span class="truncate text-sm font-semibold">{data.viewer.guildName}</span>
        <span class="sub">Discord × Notion MCP</span>
      </div>
    </div>
    <nav aria-label="メニュー" class="nav-list">
      {#each nav as item (item.href)}
        <a class="nav" href={item.href} aria-current={isActive(item.href) ? "page" : undefined}>
          <item.icon class="size-4 shrink-0" />
          {item.label}
        </a>
      {/each}
    </nav>
    <div class="sidebar-foot">
      <a class="nav nav-foot" href={CONNECT_PATH} title="接続方法">
        <PlugIcon class="size-4 shrink-0" />
        <span class="nav-foot-label">接続方法</span>
      </a>
      <ThemeToggle />
    </div>
    <div class="account">
      <AppAvatar name={data.viewer.displayName} url={data.viewer.avatarUrl} />
      <div class="stack">
        <span class="truncate text-sm font-medium">{data.viewer.displayName}</span>
        <span class="sub">
          <span class="inline-block max-w-full truncate align-bottom">@{data.viewer.username}</span> ·
          <span class="whitespace-nowrap">{data.viewer.roleLabel}</span>
        </span>
      </div>
      <form method="post" action={SIGN_OUT_PATH}>
        <Button type="submit" variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="ログアウト" title="ログアウト">
          <LogOutIcon />
        </Button>
      </form>
    </div>
  </aside>
  <main class="main">
    <ActionFeedback result={page.form?.result} />
    {@render children()}
  </main>
</div>
