<script lang="ts">
  import HistoryIcon from "@lucide/svelte/icons/history";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import UsersIcon from "@lucide/svelte/icons/users";
  import { page } from "$app/state";
  import ActionFeedback from "$lib/components/app/action-feedback.svelte";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import { Button } from "$lib/components/ui/button";
  import { initialOf } from "$lib/initial";
  import { ADMIN_PATH, SIGN_OUT_PATH } from "$lib/paths";

  let { data, children } = $props();

  const NAV = [
    { href: ADMIN_PATH, label: "概要", icon: LayoutDashboardIcon },
    { href: `${ADMIN_PATH}/grants`, label: "権限", icon: ShieldIcon },
    { href: `${ADMIN_PATH}/users`, label: "ユーザー", icon: UsersIcon },
    { href: `${ADMIN_PATH}/audit`, label: "Notion 書き込み履歴", icon: HistoryIcon },
  ];

  const isActive = (href: string) => (href === ADMIN_PATH ? page.url.pathname === ADMIN_PATH : page.url.pathname.startsWith(href));
</script>

<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo" aria-hidden="true">{initialOf(data.admin.guildName)}</div>
      <div class="stack">
        <span class="truncate-line text-sm font-semibold">{data.admin.guildName}</span>
        <span class="sub">Discord × Notion MCP</span>
      </div>
    </div>
    <nav aria-label="管理メニュー" class="nav-list">
      {#each NAV as item (item.href)}
        <a class="nav" href={item.href} aria-current={isActive(item.href) ? "page" : undefined}>
          <item.icon class="size-4 shrink-0" />
          {item.label}
        </a>
      {/each}
    </nav>
    <div class="account">
      <AppAvatar name={data.admin.displayName} url={data.admin.avatarUrl} />
      <div class="stack">
        <span class="truncate-line text-sm font-medium">{data.admin.displayName}</span>
        <span class="sub">@{data.admin.username} · {data.admin.roleLabel}</span>
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
