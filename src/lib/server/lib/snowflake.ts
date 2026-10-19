import { DiscordSnowflake, Snowflake } from "@sapphire/snowflake";
import { z } from "zod";
import { parseInstant } from "./instant";

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

/** Accepts a message snowflake or an ISO 8601 datetime with a UTC offset and returns a snowflake cursor. */
export function parseMessageCursor(value: string): string {
  const trimmed = value.trim();
  if (isSnowflake(trimmed)) return trimmed;
  const instant = parseInstant(trimmed);
  if (instant) return dateToSnowflake(new Date(instant.epochMilliseconds));
  throw new Error(`Invalid cursor "${value}": expected a message id or an ISO 8601 datetime with a time zone`);
}

/** Compared as numbers: the string fast path of `Snowflake.compare` misorders ids with leading zeros. */
export function compareSnowflakes(a: string, b: string): number {
  return Snowflake.compare(BigInt(a), BigInt(b));
}
