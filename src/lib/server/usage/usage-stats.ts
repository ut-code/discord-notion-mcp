import { and, count, desc, eq, gte, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { notionAudit, toolCall } from "../db/schema";
import { jstDaySql } from "../lib/jst-day";

/** How many rows of the group meet all the conditions. */
const countWhere = (...conditions: [SQL, ...SQL[]]) => sql<number>`coalesce(sum(case when ${and(...conditions)} then 1 else 0 end), 0)`;
const failures = countWhere(eq(toolCall.ok, false));
/**
 * Calls that ran. Rate-limited ones were refused before reaching the tool: they are counted
 * apart (rateLimited) and left out of calls, failures, durations and last use.
 */
const ran = or(isNull(toolCall.errorKind), ne(toolCall.errorKind, "rate_limited"));

/** Aggregates over the tool call log and the Notion audit log since a point in time; days are JST day numbers. */
export class UsageStats {
  constructor(private readonly db: AppDatabase) {}

  dailyByTool(since: Date): Array<{ day: number; tool: string; calls: number }> {
    const day = jstDaySql(toolCall.createdAt);
    return this.db
      .select({ day, tool: toolCall.tool, calls: count() })
      .from(toolCall)
      .where(and(gte(toolCall.createdAt, since), ran))
      .groupBy(day, toolCall.tool)
      .all();
  }

  byUser(since: Date): Array<{ discordUserId: string; calls: number; failures: number; lastUsed: Date }> {
    const rows = this.db
      .select({
        discordUserId: toolCall.discordUserId,
        calls: count(),
        failures,
        lastUsed: sql<number>`max(${toolCall.createdAt})`,
      })
      .from(toolCall)
      .where(and(gte(toolCall.createdAt, since), ran))
      .groupBy(toolCall.discordUserId)
      .orderBy(desc(count()), toolCall.discordUserId)
      .all();
    return rows.map((row) => ({ ...row, lastUsed: new Date(row.lastUsed) }));
  }

  byTool(since: Date): Array<{ tool: string; calls: number; failures: number; avgDurationMs: number }> {
    return this.db
      .select({ tool: toolCall.tool, calls: count(), failures, avgDurationMs: sql<number>`avg(${toolCall.durationMs})` })
      .from(toolCall)
      .where(and(gte(toolCall.createdAt, since), ran))
      .groupBy(toolCall.tool)
      .orderBy(desc(count()), toolCall.tool)
      .all();
  }

  /** When each user last called a tool; users without a call in the kept log (TOOL_CALL_RETENTION_DAYS) are absent. */
  lastUsed(discordUserIds: readonly string[]): Map<string, Date> {
    if (discordUserIds.length === 0) return new Map();
    const rows = this.db
      .select({ discordUserId: toolCall.discordUserId, at: sql<number>`max(${toolCall.createdAt})` })
      .from(toolCall)
      .where(and(inArray(toolCall.discordUserId, [...discordUserIds]), ran))
      .groupBy(toolCall.discordUserId)
      .all();
    return new Map(rows.map((row) => [row.discordUserId, new Date(row.at)]));
  }

  rateLimited(since: Date): number {
    const [row] = this.db
      .select({ total: count() })
      .from(toolCall)
      .where(and(gte(toolCall.createdAt, since), eq(toolCall.errorKind, "rate_limited")))
      .all();
    return row?.total ?? 0;
  }

  notionTotals(since: Date): { writes: number; reverts: number; failures: number } {
    const [row] = this.db
      .select({
        writes: countWhere(eq(notionAudit.status, "ok"), ne(notionAudit.operation, "revert")),
        reverts: countWhere(eq(notionAudit.status, "ok"), eq(notionAudit.operation, "revert")),
        // Interrupted writes may or may not have been applied: they need a look like failures do.
        failures: countWhere(inArray(notionAudit.status, ["failed", "interrupted"])),
      })
      .from(notionAudit)
      .where(gte(notionAudit.createdAt, since))
      .all();
    return row ?? { writes: 0, reverts: 0, failures: 0 };
  }
}
