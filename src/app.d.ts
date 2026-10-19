import type { ViewerGate } from "#lib/server/dashboard/access.js";
import type { DashboardDeps } from "#lib/server/dashboard/deps.js";
import type { Preview } from "#lib/server/preview.js";
import type { Theme } from "#lib/theme.js";

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
      viewerGate: () => Promise<ViewerGate>;
      /** Only under `bun run preview`. */
      preview: Preview | null;
      /** From the `theme` cookie. */
      theme: Theme;
    }
  }
}

export {};
