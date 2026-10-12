import { z } from "zod";

/** Discord ids (snowflakes) as decimal strings. */
export const SNOWFLAKE_PATTERN = /^\d{15,22}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_PATTERN.test(value);
}

export const snowflakeSchema = z.string().regex(SNOWFLAKE_PATTERN, "must be a Discord id (numeric snowflake)");

const DISCORD_EPOCH_MS = 1420070400000n;

export function snowflakeToDate(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS));
}

/** Smallest snowflake whose timestamp equals the given instant. */
export function dateToSnowflake(date: Date): string {
  const ms = BigInt(date.getTime());
  if (ms < DISCORD_EPOCH_MS) throw new RangeError("Date is before the Discord epoch (2015-01-01)");
  return ((ms - DISCORD_EPOCH_MS) << 22n).toString();
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

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
