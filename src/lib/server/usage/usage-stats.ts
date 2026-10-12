import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { notionAudit, toolCall } from "../db/schema";

export const DAY_MS = 24 * 60 * 60_000;
export const JST_OFFSET_MS = 9 * 60 * 60_000;

/** Japan-time day number (days since the epoch in JST). */
export function jstDay(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
}

const jstDayExpr = (column: typeof toolCall.createdAt | typeof notionAudit.createdAt) =>
  sql<number>`cast((${column} + ${sql.raw(String(JST_OFFSET_MS))}) / ${sql.raw(String(DAY_MS))} as integer)`;
const failed = sql<number>`coalesce(sum(case when ${toolCall.ok} = 0 then 1 else 0 end), 0)`;

/** Aggregates over the tool call log and the Notion audit log since a point in time; days are JST day numbers. */
export class UsageStats {
  constructor(private readonly db: AppDatabase) {}

  dailyByTool(since: Date): Array<{ day: number; tool: string; calls: number }> {
    const day = jstDayExpr(toolCall.createdAt);
    return this.db
      .select({ day, tool: toolCall.tool, calls: count() })
      .from(toolCall)
      .where(gte(toolCall.createdAt, since))
      .groupBy(day, toolCall.tool)
      .all();
  }

  byUser(since: Date): Array<{ discordUserId: string; calls: number; failures: number; lastUsed: Date }> {
    const rows = this.db
      .select({ discordUserId: toolCall.discordUserId, calls: count(), failures: failed, lastUsed: sql<number>`max(${toolCall.createdAt})` })
      .from(toolCall)
      .where(gte(toolCall.createdAt, since))
      .groupBy(toolCall.discordUserId)
      .orderBy(desc(count()), toolCall.discordUserId)
      .all();
    return rows.map((row) => ({ ...row, lastUsed: new Date(row.lastUsed) }));
  }

  byTool(since: Date): Array<{ tool: string; calls: number; failures: number; avgDurationMs: number }> {
    return this.db
      .select({ tool: toolCall.tool, calls: count(), failures: failed, avgDurationMs: sql<number>`avg(${toolCall.durationMs})` })
      .from(toolCall)
      .where(gte(toolCall.createdAt, since))
      .groupBy(toolCall.tool)
      .orderBy(desc(count()), toolCall.tool)
      .all();
  }

  rateLimited(since: Date): number {
    const [row] = this.db
      .select({ total: count() })
      .from(toolCall)
      .where(and(gte(toolCall.createdAt, since), eq(toolCall.errorKind, "rate_limited")))
      .all();
    return row?.total ?? 0;
  }

  notionDaily(since: Date): Array<{ day: number; writes: number; reverts: number; failures: number }> {
    const day = jstDayExpr(notionAudit.createdAt);
    const tally = (condition: ReturnType<typeof sql>) => sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`;
    return this.db
      .select({
        day,
        writes: tally(sql`${notionAudit.status} = 'ok' and ${notionAudit.operation} != 'revert'`),
        reverts: tally(sql`${notionAudit.status} = 'ok' and ${notionAudit.operation} = 'revert'`),
        failures: tally(sql`${notionAudit.status} = 'failed'`),
      })
      .from(notionAudit)
      .where(gte(notionAudit.createdAt, since))
      .groupBy(day)
      .all();
  }
}
