<script lang="ts">
  import BadgeCheckIcon from "@lucide/svelte/icons/badge-check";
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import EyeIcon from "@lucide/svelte/icons/eye";
  import FileTextIcon from "@lucide/svelte/icons/file";
  import PenLineIcon from "@lucide/svelte/icons/pen-line";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import AuthLayout from "$lib/components/app/auth-layout.svelte";
  import { Button } from "$lib/components/ui/button";
  import { m } from "$lib/paraglide/messages.js";
  import { SIGN_OUT_PATH } from "$lib/paths";
  import { jsonStrings } from "$lib/json-strings";
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
      throw new Error(result.message || result.error_description || m.consent_failed());
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      busy = false;
    }
  }
</script>

<AuthLayout title={`${m.consent_title()} — Discord × Notion MCP`} wide>
  <section class="auth-card">
    <div class="stack gap-2">
      <h1><span>{data.clientName}</span> {m.consent_heading_suffix()}</h1>
      <p class="lead">{m.consent_lead()}</p>
    </div>

    <ul class="stack gap-1.5 text-[13px]">
      {#if data.verifiedHost}
        <li class="flex items-center gap-1.5">
          <BadgeCheckIcon class="size-4 shrink-0 text-ok-fg" />{m.consent_publisher_verified({ host: data.verifiedHost })}
        </li>
      {:else}
        <li class="flex items-center gap-1.5 text-warn-text">
          <CircleAlertIcon class="size-4 shrink-0" />{m.consent_publisher_unverified()}
        </li>
      {/if}
      {#if data.redirect?.local}
        <li class="break-all">{m.consent_redirect_local({ origin: data.redirect.origin })}</li>
        {#if data.verifiedHost}<li class="text-muted-foreground">{m.consent_redirect_local_unverifiable()}</li>{/if}
      {:else if data.redirect}
        <li
          class="flex items-center gap-1.5 rounded-md border border-warn-border bg-warn-bg px-2 py-1.5 font-medium break-all text-warn-text"
        >
          <TriangleAlertIcon class="size-4 shrink-0" />{m.consent_redirect_external({ origin: data.redirect.origin })}
        </li>
      {/if}
    </ul>

    <div class="flex items-center gap-3 rounded-[10px] border p-3">
      <AppAvatar name={data.account.name} url={data.account.avatarUrl} size="lg" />
      <div class="stack grow">
        <span class="truncate text-sm font-medium">{data.account.name}</span>
        <span class="mono">@{data.account.username} · {data.guildName}</span>
      </div>
      <form method="post" action={SIGN_OUT_PATH}>
        <input type="hidden" name="next" value={data.switchNext} />
        <button class="cursor-pointer text-[13px] text-text-4 underline hover:text-foreground" type="submit"
          >{m.consent_switch_account()}</button
        >
      </form>
    </div>

    <div class="flex flex-col">
      <span class="mb-1 text-[13px] font-medium text-text-4">{m.consent_features_heading()}</span>
      {#if data.features.length === 0}
        <p class="py-3 text-[13px] text-muted-foreground">{m.consent_no_features()}</p>
      {:else}
        {#each data.features as feature (feature.permission)}
          {@const Icon = ICONS[feature.permission]}
          <div class="flex items-start gap-3 border-b border-muted py-3 last:border-b-0">
            <Icon class="mt-0.5 size-4 shrink-0 text-foreground" />
            <div class="stack">
              <span class="text-sm font-medium">{feature.title}</span>
              <span class="text-[13px] text-muted-foreground">{feature.description}</span>
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
      <p class="text-[13px] text-bad-fg" role="status">{status}</p>
    {/if}
  </section>
  <p class="text-center text-xs leading-relaxed text-muted-foreground">{m.consent_footer()}</p>
</AuthLayout>
