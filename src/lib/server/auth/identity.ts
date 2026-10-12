import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { authAccount } from "../db/better-auth-tables";

export const DISCORD_PROVIDER_ID = "discord";

/** Maps Better Auth user ids to linked Discord user ids via the `account` table. */
export class DiscordIdentityStore {
  constructor(private readonly db: AppDatabase) {}

  async discordUserIdForUser(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ accountId: authAccount.accountId })
      .from(authAccount)
      .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, DISCORD_PROVIDER_ID)))
      .limit(1);
    return rows[0]?.accountId ?? null;
  }

  async discordUserIdFromClaims(claims: { sub?: unknown }): Promise<string | null> {
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
    return this.discordUserIdForUser(claims.sub);
  }
}
