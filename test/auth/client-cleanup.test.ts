import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deleteUnusedClients, startClientCleanup, UNUSED_CLIENT_TTL_MS } from "../../src/lib/server/auth/client-cleanup";
import type { AppDatabase } from "../../src/lib/server/db/client";
import type { ErrorEntry, EventEntry } from "../../src/lib/server/lib/log";
import { FakeDiscordApi, makeMember } from "../../src/lib/server/fakes/discord";
import { issueTokens, registerClient, signIn, startHarness, type Harness } from "../support/harness";

const DAY_MS = 24 * 60 * 60_000;
const MEMBER = "300000000000000001";

let h: Harness;

const clientIds = (): string[] =>
  (h.server.database.sqlite.query("select clientId from oauthClient order by clientId").all() as Array<{ clientId: string }>).map(
    (row) => row.clientId,
  );

function insert(table: "oauthAccessToken" | "oauthRefreshToken" | "oauthConsent", values: Record<string, string | null>): void {
  const now = new Date().toISOString();
  const row: Record<string, string | null> = { id: crypto.randomUUID(), createdAt: now, scopes: "[]", ...values };
  if (table === "oauthConsent") row.updatedAt = now;
  else Object.assign(row, { token: crypto.randomUUID(), expiresAt: now });
  const columns = Object.keys(row);
  h.server.database.sqlite
    .query(`insert into "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) values (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}

beforeAll(async () => {
  const discord = new FakeDiscordApi();
  discord.members.set(MEMBER, makeMember(MEMBER));
  h = await startHarness({ discord });
});

afterAll(async () => {
  await h?.stop();
});

describe("unused OAuth client cleanup", () => {
  test("deletes old clients without access tokens, refresh tokens or consents", async () => {
    const { userId, cookie } = await signIn(h, MEMBER);
    const unused = await registerClient(h);
    const withAccessToken = await registerClient(h);
    const withRefreshToken = await registerClient(h);
    const withConsent = await registerClient(h);
    const connected = await registerClient(h);
    insert("oauthAccessToken", { clientId: withAccessToken });
    insert("oauthRefreshToken", { clientId: withRefreshToken, userId });
    insert("oauthConsent", { clientId: withConsent });
    await issueTokens(h, connected, cookie);
    const db = h.server.database.db;

    // Every client is younger than the cutoff of 7 days.
    expect(deleteUnusedClients(db, new Date(Date.now() - UNUSED_CLIENT_TTL_MS))).toBe(0);
    expect(clientIds()).toContain(unused);

    expect(deleteUnusedClients(db, new Date(Date.now() + 60_000))).toBe(1);
    expect(clientIds()).toEqual([withAccessToken, withRefreshToken, withConsent, connected].sort());
  });

  test("runs at startup and then on every interval, logging the count", async () => {
    let now = Date.now();
    const events: EventEntry[] = [];
    const stop = startClientCleanup({
      db: h.server.database.db,
      now: () => now,
      intervalMs: 20,
      log: (entry) => events.push(entry),
      logError: () => {},
    });
    expect(events).toEqual([]);

    const abandoned = await registerClient(h);
    now += UNUSED_CLIENT_TTL_MS + DAY_MS;
    await Bun.sleep(60);
    expect(events).toEqual([{ event: "oauth_clients_pruned", deleted: 1 }]);
    expect(clientIds()).not.toContain(abandoned);
    stop();
  });

  test("a failing cleanup is logged, not thrown", () => {
    const errors: ErrorEntry[] = [];
    const db = {
      delete: () => {
        throw new Error("locked");
      },
    } as unknown as AppDatabase;
    const stop = startClientCleanup({ db, log: () => {}, logError: (entry) => errors.push(entry) });
    stop();
    expect(errors).toEqual([{ event: "oauth_client_prune_failed", error: "locked" }]);
  });
});
