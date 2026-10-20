import { sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

// Calendar days in Japan time as day numbers (days since the epoch, each starting at 00:00 JST).
// Japan has no daylight saving time, so a fixed +9 h offset is exact; it also works in SQLite,
// which has no time zone data.

/** The community's time zone: dashboard dates and the @today / @now of Notion templates. */
export const JST_TIME_ZONE = "Asia/Tokyo";

const DAY_MS = 24 * 60 * 60_000;
const JST_OFFSET_MS = 9 * 60 * 60_000;

/** The JST day a moment (epoch ms) falls on. */
export function jstDay(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
}

/** 00:00 JST of a day. */
export function jstDayStart(day: number): Date {
  return new Date(day * DAY_MS - JST_OFFSET_MS);
}

/** `jstDay` in SQL, for an epoch-ms column. */
export function jstDaySql(column: SQLiteColumn): SQL<number> {
  return sql<number>`cast((${column} + ${sql.raw(String(JST_OFFSET_MS))}) / ${sql.raw(String(DAY_MS))} as integer)`;
}
