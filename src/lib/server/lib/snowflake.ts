import { DiscordSnowflake, Snowflake } from "@sapphire/snowflake";
import { z } from "zod";

/** Discord ids (snowflakes) as decimal strings. */
const SNOWFLAKE_PATTERN = /^\d{15,22}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_PATTERN.test(value);
}

export const snowflakeSchema = z.string().regex(SNOWFLAKE_PATTERN, "must be a Discord id (numeric snowflake)");

/** `deconstruct` keeps bigint precision (`timestampFrom` goes through a lossy Number). */
export function snowflakeToDate(id: string): Date {
  return new Date(Number(DiscordSnowflake.deconstruct(id).timestamp));
}

/** Smallest snowflake whose timestamp equals the given instant. */
export function dateToSnowflake(date: Date): string {
  if (BigInt(date.getTime()) < DiscordSnowflake.epoch) throw new RangeError("Date is before the Discord epoch (2015-01-01)");
  return DiscordSnowflake.generate({ timestamp: date, increment: 0n, processId: 0n, workerId: 0n }).toString();
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/** Accepts a message snowflake or an ISO 8601 date/datetime and returns a snowflake cursor. */
export function parseMessageCursor(value: string): string {
  const trimmed = value.trim();
  if (isSnowflake(trimmed)) return trimmed;
  if (ISO_DATETIME.test(trimmed)) {
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
    const isDateOnly = !/[T ]/.test(trimmed);
    const normalized = hasZone || isDateOnly ? trimmed : `${trimmed}Z`;
    const date = new Date(normalized.replace(" ", "T"));
    if (!Number.isNaN(date.getTime())) return dateToSnowflake(date);
  }
  throw new Error(`Invalid cursor "${value}": expected a message id or an ISO 8601 datetime`);
}

/** Compared as numbers: the string fast path of `Snowflake.compare` misorders ids with leading zeros. */
export function compareSnowflakes(a: string, b: string): number {
  return Snowflake.compare(BigInt(a), BigInt(b));
}
