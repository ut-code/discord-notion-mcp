<script lang="ts">
  import type { Snippet } from "svelte";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { actionUrl } from "$lib/action-url";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import { useHydrated } from "$lib/hydrated.svelte";

  let {
    id,
    open = $bindable(false),
    title,
    description,
    action,
    submitLabel,
    destructive = false,
    fields,
  }: {
    /** Id of the native popover that stands in before hydration (its trigger targets it). */
    id: string;
    open?: boolean;
    title: string;
    description?: string;
    /** Named form action of the current page. */
    action: string;
    submitLabel: string;
    destructive?: boolean;
    /** Hidden inputs posted with the confirmation. */
    fields: Snippet;
  } = $props();

  const hydrated = useHydrated();
  const url = $derived(actionUrl(page.url, action));
  const variant = $derived(destructive ? "destructive" : "default");
</script>

{#if hydrated.current}
  <AlertDialog.Root bind:open>
    <AlertDialog.Content>
      <AlertDialog.Header>
        <AlertDialog.Title>{title}</AlertDialog.Title>
        {#if description}<AlertDialog.Description>{description}</AlertDialog.Description>{/if}
      </AlertDialog.Header>
      <form
        method="post"
        action={url}
        use:enhance={() =>
          async ({ update }) => {
            open = false;
            await update();
          }}
      >
        {@render fields()}
        <AlertDialog.Footer>
          <AlertDialog.Cancel type="button">キャンセル</AlertDialog.Cancel>
          <Button type="submit" {variant}>{submitLabel}</Button>
        </AlertDialog.Footer>
      </form>
    </AlertDialog.Content>
  </AlertDialog.Root>
{:else}
  <div class="native-dialog" {id} popover="auto" role="dialog" aria-labelledby={`${id}-title`}>
    <p class="text-base font-semibold" id={`${id}-title`}>{title}</p>
    {#if description}<p class="text-muted-foreground text-sm">{description}</p>{/if}
    <form method="post" action={url} class="mt-4 flex justify-end gap-2">
      {@render fields()}
      <Button variant="outline" popovertarget={id} popovertargetaction="hide">キャンセル</Button>
      <Button type="submit" {variant}>{submitLabel}</Button>
    </form>
  </div>
{/if}
