import type { ViewerGate } from "$lib/server/dashboard/access";
import type { DashboardDeps } from "$lib/server/dashboard/deps";
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
      deps: DashboardDeps;
      /** Dashboard access of the browser session, resolved once per request. */
      viewer: () => Promise<ViewerGate>;
      /** Only under `bun run preview`. */
      preview: Preview | null;
    }
  }
}

export {};
