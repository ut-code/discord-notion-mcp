<script lang="ts">
  import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import PlugIcon from "@lucide/svelte/icons/plug";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import UsersIcon from "@lucide/svelte/icons/users";
  import { page } from "$app/state";
  import ActionFeedback from "$lib/components/app/action-feedback.svelte";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import ConnectGuide from "$lib/components/app/connect-guide.svelte";
  import ThemeToggle from "$lib/components/app/theme-toggle.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { initialOf } from "$lib/initial";
  import { m } from "$lib/paraglide/messages.js";
  import { CONNECT_PATH, DASHBOARD_PATH, SIGN_OUT_PATH } from "$lib/paths";
  import { actionResultOf } from "$lib/action-result";
  import type { LayoutProps } from "./$types";

  let { data, children }: LayoutProps = $props();

  const nav = $derived([
    { href: DASHBOARD_PATH, label: m.stats_title(), icon: ChartColumnIcon },
    ...(data.viewer.isAdmin ? [{ href: `${DASHBOARD_PATH}/grants`, label: m.grants_title(), icon: ShieldIcon }] : []),
    { href: `${DASHBOARD_PATH}/users`, label: m.users_title(), icon: UsersIcon },
    ...(data.viewer.canViewAudit ? [{ href: `${DASHBOARD_PATH}/audit`, label: m.audit_title(), icon: HistoryIcon }] : []),
  ]);

  let connectOpen = $state(false);

  function openConnect(event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    connectOpen = true;
  }

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
    <nav aria-label={m.nav_label()} class="nav-list">
      {#each nav as item (item.href)}
        <a class="nav" href={item.href} aria-current={isActive(item.href) ? "page" : undefined}>
          <item.icon class="size-4 shrink-0" />
          {item.label}
        </a>
      {/each}
    </nav>
    <div class="sidebar-foot">
      <!-- Without JavaScript the link opens the connection page instead of the dialog. -->
      <a class="nav nav-foot" href={CONNECT_PATH} title={m.connect_title()} onclick={openConnect}>
        <PlugIcon class="size-4 shrink-0" />
        <span class="nav-foot-label">{m.connect_title()}</span>
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
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          aria-label={m.common_sign_out()}
          title={m.common_sign_out()}
        >
          <LogOutIcon />
        </Button>
      </form>
    </div>
  </aside>
  <main class="main">
    <ActionFeedback result={actionResultOf(page.form)} />
    {@render children()}
  </main>
</div>

<Dialog.Root bind:open={connectOpen}>
  <Dialog.Content class="sm:max-w-[480px]">
    <Dialog.Header>
      <Dialog.Title>{m.connect_title()}</Dialog.Title>
    </Dialog.Header>
    <ConnectGuide mcpUrl={data.mcpUrl} heading="h3" />
  </Dialog.Content>
</Dialog.Root>
