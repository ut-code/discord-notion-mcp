import { and, count, desc, eq, max } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { authAccount, authSession, authUser } from "../db/better-auth-tables";
import { tokenRevocation } from "../db/schema";
import { DISCORD_PROVIDER_ID } from "./identity";

export interface LoginUser {
  userId: string;
  name: string;
  discordUserId: string | null;
  createdAt: Date;
  /** Latest session creation or Discord account update (both happen on every login). */
  lastLoginAt: Date | null;
  revokedAt: Date | null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latest(...dates: Array<Date | null>): Date | null {
  return dates.reduce<Date | null>((acc, date) => (date && (!acc || date > acc) ? date : acc), null);
}

/** Users who have signed in at least once (Better Auth `user` + linked Discord `account`). */
export class LoginUserStore {
  constructor(private readonly db: AppDatabase) {}

  async find(userId: string): Promise<{ userId: string; name: string } | null> {
    const [row] = await this.db.select({ userId: authUser.id, name: authUser.name }).from(authUser).where(eq(authUser.id, userId));
    return row ?? null;
  }

  async count(): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(authUser);
    return row?.total ?? 0;
  }

  /** Newest users first. */
  async list(query: { limit: number; offset: number }): Promise<LoginUser[]> {
    const lastSession = this.db
      .select({ userId: authSession.userId, at: max(authSession.createdAt).as("last_session_at") })
      .from(authSession)
      .groupBy(authSession.userId)
      .as("last_session");
    const rows = await this.db
      .select({
        userId: authUser.id,
        name: authUser.name,
        createdAt: authUser.createdAt,
        discordUserId: authAccount.accountId,
        accountUpdatedAt: authAccount.updatedAt,
        lastSessionAt: lastSession.at,
        revokedAt: tokenRevocation.revokedAt,
      })
      .from(authUser)
      .leftJoin(authAccount, and(eq(authAccount.userId, authUser.id), eq(authAccount.providerId, DISCORD_PROVIDER_ID)))
      .leftJoin(lastSession, eq(lastSession.userId, authUser.id))
      .leftJoin(tokenRevocation, eq(tokenRevocation.userId, authUser.id))
      .orderBy(desc(authUser.createdAt), authUser.id)
      .limit(query.limit)
      .offset(query.offset);
    return rows.map((row) => ({
      userId: row.userId,
      name: row.name,
      discordUserId: row.discordUserId,
      createdAt: parseDate(row.createdAt) ?? new Date(0),
      lastLoginAt: latest(parseDate(row.lastSessionAt), parseDate(row.accountUpdatedAt)),
      revokedAt: row.revokedAt,
    }));
  }
}
