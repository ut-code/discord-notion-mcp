<script lang="ts" module>
  export type GrantSubject =
    | { type: "role"; id: string; label: string; color: string | null }
    | { type: "user"; id: string; label: string; avatarUrl: string | null };
</script>

<script lang="ts">
  import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import AppAvatar from "$lib/components/app/app-avatar.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Command from "$lib/components/ui/command";
  import * as Popover from "$lib/components/ui/popover";
  import { DASHBOARD_PATH } from "$lib/paths";
  import type { GrantFormView } from "$lib/server/dashboard/grants";
  import { MemberLookup } from "./member-lookup.svelte";

  let {
    id,
    roles,
    selected = $bindable(),
  }: { id: string; roles: GrantFormView["roles"]; selected: GrantSubject | null } = $props();

  let open = $state(false);
  let query = $state("");
  const lookup = new MemberLookup(`${DASHBOARD_PATH}/grants/members`);

  const fold = (text: string) => text.normalize("NFKC").toLowerCase();
  const needle = $derived(fold(query.trim().replace(/^@/, "")));
  const matchingRoles = $derived(needle ? roles.filter((role) => fold(role.name).includes(needle)) : roles);
  const showMembers = $derived(query.trim() !== "" && (lookup.members.length > 0 || !lookup.loading));

  $effect(() => {
    lookup.search(query);
  });
  $effect(() => () => lookup.cancel());

  function choose(subject: GrantSubject) {
    selected = subject;
    open = false;
    query = "";
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props} {id} variant="outline" class="w-full justify-between gap-2 px-3 font-normal" role="combobox" aria-expanded={open}>
        {#if selected?.type === "role"}
          <span class="flex min-w-0 items-center gap-2">
            <span class="dot" style:background={selected.color ?? undefined}></span>
            <span class="truncate">{selected.label}</span>
          </span>
        {:else if selected}
          <span class="flex min-w-0 items-center gap-2">
            <AppAvatar name={selected.label} url={selected.avatarUrl} size="sm" />
            <span class="truncate">{selected.label}</span>
          </span>
        {:else}
          <span class="text-muted-foreground">選択してください</span>
        {/if}
        <ChevronsUpDownIcon class="text-muted-foreground size-4" />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-(--bits-popover-anchor-width) min-w-64 p-0" align="start">
    <Command.Root shouldFilter={false}>
      <div class="relative">
        <Command.Input bind:value={query} placeholder="ロール・名前・@ユーザー名・ID" aria-label="対象を検索" />
        {#if lookup.loading}
          <span class="text-muted-foreground absolute top-1/2 right-3.5 -translate-y-1/2" role="status" aria-label="検索中">
            <LoaderCircleIcon class="size-4 animate-spin" />
          </span>
        {/if}
      </div>
      <Command.List>
        {#if matchingRoles.length > 0}
          <Command.Group heading="ロール">
            {#each matchingRoles as role (role.id)}
              <Command.Item
                value={`role:${role.id}`}
                data-checked={selected?.type === "role" && selected.id === role.id}
                onSelect={() => choose({ type: "role", id: role.id, label: role.handle, color: role.color })}
              >
                <span class="dot" style:background={role.color ?? undefined}></span>
                <span class="truncate">{role.handle}</span>
              </Command.Item>
            {/each}
          </Command.Group>
        {/if}
        {#if showMembers}
          <Command.Group heading="メンバー">
            {#each lookup.members as member (member.id)}
              <Command.Item
                value={`user:${member.id}`}
                data-checked={selected?.type === "user" && selected.id === member.id}
                onSelect={() => choose({ type: "user", id: member.id, label: member.name, avatarUrl: member.avatarUrl })}
              >
                <AppAvatar name={member.name} url={member.avatarUrl} size="md" />
                <span class="stack">
                  <span class="truncate">{member.name}</span>
                  <span class="mono truncate">{member.secondLine}</span>
                </span>
              </Command.Item>
            {:else}
              <p class={["px-2 py-1.5 text-[13px]", lookup.error ? "text-bad-fg" : "text-muted-foreground"]}>
                {lookup.error ?? "一致するメンバーはいません"}
              </p>
            {/each}
          </Command.Group>
        {/if}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
