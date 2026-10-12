<script lang="ts">
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import * as Alert from "$lib/components/ui/alert";
  import type { ActionResult } from "$lib/server/dashboard/shared";
  import { cn } from "$lib/utils";

  let { result }: { result: ActionResult | null | undefined } = $props();

  // Without JavaScript the result stays a banner; once hydrated it becomes a toast.
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });

  $effect(() => {
    const message = result?.message;
    if (!result || !message) return;
    if (result.kind === "ok") toast.success(message);
    else if (result.kind === "warn") toast.warning(message);
    else toast.error(message);
  });

  const styles = {
    ok: "border-ok-border bg-ok-bg text-ok-text",
    warn: "border-warn-border bg-warn-bg text-warn-text",
    error: "border-bad-border bg-bad-bg text-bad-text",
  };
</script>

{#if !hydrated && result?.message}
  <Alert.Root class={cn("whitespace-pre-wrap", styles[result.kind])} role={result.kind === "error" ? "alert" : "status"}>
    {#if result.kind === "ok"}
      <CircleCheckIcon />
    {:else if result.kind === "warn"}
      <TriangleAlertIcon />
    {:else}
      <CircleAlertIcon />
    {/if}
    <Alert.Title class="font-normal">{result.message}</Alert.Title>
  </Alert.Root>
{/if}
