import { eq, inArray, or, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { authSession, oauthAccessToken, oauthRefreshToken } from "../db/better-auth-tables";
import { tokenRevocation } from "../db/schema";

export interface RevocationResult {
  revokedAt: Date;
  sessions: number;
  refreshTokens: number;
  accessTokens: number;
}

/**
 * Immediate revocation for a Better Auth user. Access tokens are JWTs verified by
 * signature alone, so deleting rows cannot invalidate them before they expire; the
 * MCP endpoint therefore also rejects every token issued at or before `revokedAt`.
 */
export class TokenRevocationService {
  private readonly lookup;

  constructor(private readonly db: AppDatabase) {
    this.lookup = db
      .select({ revokedAt: tokenRevocation.revokedAt })
      .from(tokenRevocation)
      .where(eq(tokenRevocation.userId, sql.placeholder("userId")))
      .prepare();
  }

  /** `issuedAt` is the JWT `iat` claim in seconds; a token without one is treated as revoked. */
  isRevoked(userId: string, issuedAt: unknown): boolean {
    const row = this.lookup.get({ userId });
    if (!row) return false;
    if (typeof issuedAt !== "number") return true;
    return issuedAt * 1000 <= row.revokedAt.getTime();
  }

  /** Records the revocation and deletes the user's sessions and OAuth token rows atomically. */
  revoke(userId: string, now: Date = new Date()): RevocationResult {
    return this.db.transaction((tx) => {
      tx.insert(tokenRevocation)
        .values({ userId, revokedAt: now })
        .onConflictDoUpdate({ target: tokenRevocation.userId, set: { revokedAt: now } })
        .run();
      const refreshIds = tx.select({ id: oauthRefreshToken.id }).from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
      const accessTokens = tx
        .delete(oauthAccessToken)
        .where(or(eq(oauthAccessToken.userId, userId), inArray(oauthAccessToken.refreshId, refreshIds)))
        .returning({ id: oauthAccessToken.id })
        .all();
      const refreshTokens = tx
        .delete(oauthRefreshToken)
        .where(eq(oauthRefreshToken.userId, userId))
        .returning({ id: oauthRefreshToken.id })
        .all();
      const sessions = tx.delete(authSession).where(eq(authSession.userId, userId)).returning({ id: authSession.id }).all();
      return { revokedAt: now, sessions: sessions.length, refreshTokens: refreshTokens.length, accessTokens: accessTokens.length };
    });
  }
}
