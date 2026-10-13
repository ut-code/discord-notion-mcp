import { and, eq, isNotNull, lt, notExists } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "../db/better-auth-tables";
import { errorMessage } from "../lib/errors";
import type { ErrorSink, EventSink } from "../lib/log";
import { runPeriodically } from "../lib/periodic";

/** Registration is open (dynamic client registration), so abandoned clients are removed after this. */
export const UNUSED_CLIENT_TTL_MS = 7 * 24 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

/** Deletes OAuth clients created before `cutoff` that have no access tokens, refresh tokens or consents; returns how many. */
export function deleteUnusedClients(db: AppDatabase, cutoff: Date): number {
  const unused = (table: typeof oauthAccessToken | typeof oauthRefreshToken | typeof oauthConsent) =>
    notExists(db.select({ id: table.id }).from(table).where(eq(table.clientId, oauthClient.clientId)));
  return db
    .delete(oauthClient)
    .where(
      and(
        isNotNull(oauthClient.createdAt),
        lt(oauthClient.createdAt, cutoff.toISOString()),
        unused(oauthAccessToken),
        unused(oauthRefreshToken),
        unused(oauthConsent),
      ),
    )
    .returning({ id: oauthClient.id })
    .all().length;
}

export interface ClientCleanupOptions {
  db: AppDatabase;
  now?: () => number;
  intervalMs?: number;
  log: EventSink;
  logError: ErrorSink;
}

/** Deletes unused OAuth clients older than 7 days now and then every 24 hours; returns a stop function. */
export function startClientCleanup({
  db,
  now = Date.now,
  intervalMs = CLEANUP_INTERVAL_MS,
  log,
  logError,
}: ClientCleanupOptions): () => void {
  return runPeriodically(() => {
    try {
      const deleted = deleteUnusedClients(db, new Date(now() - UNUSED_CLIENT_TTL_MS));
      if (deleted > 0) log({ event: "oauth_clients_pruned", deleted });
    } catch (error) {
      logError({ event: "oauth_client_prune_failed", error: errorMessage(error) });
    }
  }, intervalMs);
}
