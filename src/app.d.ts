import type { AdminDeps } from "$lib/server/admin/deps";
import type { AdminGate } from "$lib/server/admin/access";
import type { Preview } from "$lib/server/preview";

declare global {
  namespace App {
    interface Error {
      message: string;
      /** Heading of the error card; defaults to a generic title per status. */
      title?: string;
      /** Shows a sign-out button (signed-in users who cannot use the page). */
      signedIn?: boolean;
    }
    interface Locals {
      deps: AdminDeps;
      /** Admin check of the browser session, resolved once per request. */
      admin: () => Promise<AdminGate>;
      /** Only under `bun run preview`. */
      preview: Preview | null;
    }
  }
}

export {};
