<script lang="ts">
  import BadgeCheckIcon from "@lucide/svelte/icons/badge-check";
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import EyeIcon from "@lucide/svelte/icons/eye";
  import FileTextIcon from "@lucide/svelte/icons/file";
  import PenLineIcon from "@lucide/svelte/icons/pen-line";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import AppAvatar from "#lib/components/app/app-avatar.svelte";
  import AuthLayout from "#lib/components/app/auth-layout.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { m } from "#lib/paraglide/messages.js";
  import { SIGN_OUT_PATH } from "#lib/paths.js";
  import { jsonStrings } from "#lib/json-strings.js";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

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
      const result = await jsonStrings(res);
      const target = result.url || result.redirect_uri;
      if (res.ok && target) {
        window.location.href = target;
        return;
      }
      console.error("consent decision failed", res.status, result);
    } catch (error) {
      console.error(error);
    }
    status = m.consent_failed();
    busy = false;
  }
</script>

<AuthLayout title={`${m.consent_title()} — Discord × Notion MCP`} wide>
  <section class="auth-card">
    <h1><span>{data.clientName}</span> {m.consent_heading_suffix()}</h1>

    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-note">
      <dt class="text-muted-foreground">{m.consent_publisher_label()}</dt>
      {#if data.verifiedHost}
        <dd class="flex items-start gap-1.5 break-all">
          <BadgeCheckIcon class="mt-px size-4 shrink-0 text-ok-fg" />{data.verifiedHost}
        </dd>
      {:else}
        <dd class="flex items-start gap-1.5 text-warn-text">
          <CircleAlertIcon class="mt-px size-4 shrink-0" />{m.consent_publisher_unverified()}
        </dd>
      {/if}
      {#if data.redirect}
        <dt class="text-muted-foreground">{m.consent_redirect_label()}</dt>
        {#if data.redirect.local}
          <dd class="break-all">
            {m.consent_redirect_local({ origin: data.redirect.origin })}
            {#if data.verifiedHost}<span class="block text-muted-foreground">{m.consent_redirect_local_unverifiable()}</span>{/if}
          </dd>
        {:else}
          <dd class="flex items-start gap-1.5 font-medium break-all text-warn-text">
            <TriangleAlertIcon class="mt-px size-4 shrink-0" />{data.redirect.origin}
          </dd>
        {/if}
      {/if}
    </dl>

    <div class="flex items-center gap-3 rounded-lg border p-3">
      <AppAvatar name={data.account.name} url={data.account.avatarUrl} size="lg" />
      <div class="stack min-w-0 grow">
        <span class="truncate text-sm font-medium">{data.account.name}</span>
        <span class="mono truncate">@{data.account.username}</span>
        <span class="truncate text-note text-muted-foreground">{data.guildName}</span>
      </div>
      <form method="post" action={SIGN_OUT_PATH}>
        <input type="hidden" name="next" value={data.switchNext} />
        <button
          class="shrink-0 cursor-pointer text-note whitespace-nowrap text-muted-foreground underline hover:text-foreground"
          type="submit">{m.consent_switch_account()}</button
        >
      </form>
    </div>

    <div class="flex flex-col">
      <span class="mb-1 text-note font-medium text-muted-foreground">{m.consent_features_heading()}</span>
      {#if data.features.length === 0}
        <p class="py-3 text-note text-muted-foreground">{m.consent_no_features()}</p>
      {:else}
        {#each data.features as feature (feature.permission)}
          {@const Icon = ICONS[feature.permission]}
          <div class="flex items-start gap-3 border-b border-muted py-3 last:border-b-0">
            <Icon class="mt-0.5 size-4 shrink-0 text-foreground" />
            <div class="stack">
              <span class="text-sm font-medium">{feature.title}</span>
              <span class="text-note text-muted-foreground">{feature.description}</span>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="grid grid-cols-2 gap-2">
      <Button variant="outline" size="lg" disabled={busy} onclick={() => decide(false)}>{m.consent_deny()}</Button>
      <Button size="lg" disabled={busy} onclick={() => decide(true)}>{m.consent_allow()}</Button>
    </div>
    {#if status}
      <p class="text-note text-bad-fg" role="status">{status}</p>
    {/if}
  </section>
  <p class="text-center text-xs leading-relaxed text-muted-foreground">{m.consent_footer()}</p>
</AuthLayout>
