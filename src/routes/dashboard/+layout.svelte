<script lang="ts">
  import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import PlugIcon from "@lucide/svelte/icons/plug";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import UsersIcon from "@lucide/svelte/icons/users";
  import WrenchIcon from "@lucide/svelte/icons/wrench";
  import { page } from "$app/state";
  import ActionFeedback from "#lib/components/app/action-feedback.svelte";
  import AppAvatar from "#lib/components/app/app-avatar.svelte";
  import ConnectGuide from "#lib/components/app/connect-guide.svelte";
  import ThemeToggle from "#lib/components/app/theme-toggle.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import ServerLogo from "#lib/components/app/server-logo.svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { AUDIT_PATH, CALLS_PATH, CONNECT_PATH, DASHBOARD_PATH, SIGN_OUT_PATH, TOOLS_PATH } from "#lib/paths.js";
  import { actionResultOf } from "#lib/action-result.js";
  import type { LayoutProps } from "./$types";

  let { data, children }: LayoutProps = $props();

  /** `paths`: where the item counts as the current page, when that is more than its own page. */
  const nav = $derived([
    { href: DASHBOARD_PATH, label: m.stats_title(), icon: ChartColumnIcon, paths: [] },
    ...(data.viewer.isAdmin ? [{ href: `${DASHBOARD_PATH}/grants`, label: m.grants_title(), icon: ShieldIcon, paths: [] }] : []),
    { href: `${DASHBOARD_PATH}/users`, label: m.users_title(), icon: UsersIcon, paths: [] },
    ...(data.historyHref ? [{ href: data.historyHref, label: m.history_title(), icon: HistoryIcon, paths: [CALLS_PATH, AUDIT_PATH] }] : []),
    { href: TOOLS_PATH, label: m.tools_title(), icon: WrenchIcon, paths: [] },
  ]);

  let connectOpen = $state(false);

  function openConnect(event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    connectOpen = true;
  }

  const isActive = (item: { href: string; paths: string[] }) =>
    item.href === DASHBOARD_PATH
      ? page.url.pathname === DASHBOARD_PATH
      : [item.href.replace(/\?.*/, ""), ...item.paths].some((path) => page.url.pathname.startsWith(path));
</script>

<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <ServerLogo name={data.viewer.guildName} iconUrl={data.viewer.guildIconUrl} />
      <div class="stack">
        <span class="truncate text-sm font-semibold">{data.viewer.guildName}</span>
        <span class="sub">Discord × Notion MCP</span>
      </div>
    </div>
    <nav aria-label={m.nav_label()} class="nav-list">
      {#each nav as item (item.href)}
        <a class="nav" href={item.href} aria-current={isActive(item) ? "page" : undefined}>
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
        <!-- One line: a long username is cut, the role always shows. -->
        <span class="sub flex min-w-0 gap-1 whitespace-nowrap">
          <span class="truncate">@{data.viewer.username}</span>
          <span class="shrink-0">· {data.viewer.roleLabel}</span>
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
