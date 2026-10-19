/** Shown in tool descriptions and errors so callers include the offset. */
export const INSTANT_EXAMPLE = "2026-10-01T00:00:00+09:00";

/**
 * An ISO 8601 datetime with a UTC offset ("Z" or "+09:00"); null for anything else,
 * including dates and datetimes without an offset, whose time zone would be a guess.
 */
export function parseInstant(value: string): Temporal.Instant | null {
  try {
    return Temporal.Instant.from(value.trim());
  } catch {
    return null;
  }
}
