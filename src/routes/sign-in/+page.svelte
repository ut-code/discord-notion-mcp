<script lang="ts">
  import LockIcon from "@lucide/svelte/icons/lock";
  import LogInIcon from "@lucide/svelte/icons/log-in";
  import AuthLayout from "$lib/components/app/auth-layout.svelte";
  import { Button } from "$lib/components/ui/button";
  import { initialOf } from "$lib/initial";
  import { m } from "$lib/paraglide/messages.js";
  import { jsonStrings } from "$lib/json-strings";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let busy = $state(false);
  let status = $state("");

  // Better Auth starts the Discord flow from a JSON POST and answers with the provider URL.
  async function signIn() {
    busy = true;
    status = "";
    try {
      const body: Record<string, string> = { provider: "discord", callbackURL: data.callbackURL, errorCallbackURL: data.errorCallbackURL };
      if (data.oauthQuery) body.oauth_query = data.oauthQuery;
      const res = await fetch(data.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const result = await jsonStrings(res);
      if (res.ok && result.url) {
        window.location.href = result.url;
        return;
      }
      throw new Error(result.message || result.error_description || m.sign_in_start_failed());
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      busy = false;
    }
  }
</script>

<AuthLayout title={`${m.sign_in_title()} — Discord × Notion MCP`}>
  <div class="flex flex-col items-center gap-3.5 text-center">
    <div class="logo logo-lg" aria-hidden="true">{initialOf(data.guildName ?? "MCP")}</div>
    <div class="stack items-center gap-1.5">
      <h1 class="text-[22px]">{data.heading}</h1>
      <p class="text-sm text-muted-foreground">{m.sign_in_lead()}</p>
    </div>
  </div>
  <section class="auth-card">
    <Button
      type="button"
      class="h-11 w-full gap-2.5 bg-blurple text-[15px] text-white hover:bg-blurple-hover [&_svg:not([class*='size-'])]:size-[18px]"
      disabled={busy}
      onclick={signIn}
    >
      <LogInIcon />
      {m.sign_in_discord()}
    </Button>
    {#if status}
      <p class="text-[13px] text-bad-fg" role="status">{status}</p>
    {/if}
    {#if data.oauthQuery && data.clientName}
      <div class="flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-[13px] text-text-4">
        <LockIcon class="size-4" />
        <span>{m.sign_in_client()} <strong class="font-semibold text-foreground">{data.clientName}</strong></span>
      </div>
    {/if}
  </section>
</AuthLayout>
