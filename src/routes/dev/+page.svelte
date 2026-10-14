<script lang="ts">
  import AuthLayout from "$lib/components/app/auth-layout.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<AuthLayout title="Preview">
  <section class="auth-card">
    <h1>{m.dev_users_heading()}</h1>
    <ul class="grid gap-2">
      {#each data.users as user (user.id)}
        <li>
          <a
            class="block rounded-lg border px-3 py-2.5 no-underline hover:bg-muted"
            href={`/dev/login?as=${user.id}`}
            data-sveltekit-reload
          >
            {user.name} <span class="text-muted-foreground">@{user.username}</span>
          </a>
        </li>
      {/each}
    </ul>
  </section>
</AuthLayout>
