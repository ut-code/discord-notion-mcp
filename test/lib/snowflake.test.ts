import { describe, expect, test } from "bun:test";
import { compareSnowflakes, dateToSnowflake, parseMessageCursor, snowflakeToDate } from "../../src/lib/server/lib/snowflake";

describe("snowflake <-> datetime", () => {
  test("decodes the Discord documentation example", () => {
    expect(snowflakeToDate("175928847299117063").toISOString()).toBe("2016-04-30T11:18:25.796Z");
  });

  test("encodes a date to the smallest snowflake at that instant", () => {
    const id = dateToSnowflake(new Date("2016-04-30T11:18:25.796Z"));
    expect(snowflakeToDate(id).toISOString()).toBe("2016-04-30T11:18:25.796Z");
    expect(compareSnowflakes(id, "175928847299117063")).toBeLessThanOrEqual(0);
    expect(BigInt(id) & ((1n << 22n) - 1n)).toBe(0n);
  });

  test("round-trips arbitrary dates", () => {
    const date = new Date("2026-10-12T14:03:00.000Z");
    expect(snowflakeToDate(dateToSnowflake(date)).getTime()).toBe(date.getTime());
  });

  test("rejects dates before the Discord epoch", () => {
    expect(() => dateToSnowflake(new Date("2014-12-31T23:59:59Z"))).toThrow();
  });
});

describe("parseMessageCursor", () => {
  test("passes message ids through", () => {
    expect(parseMessageCursor("175928847299117063")).toBe("175928847299117063");
  });

  test("converts ISO datetimes with zone", () => {
    expect(parseMessageCursor("2016-04-30T11:18:25.796Z")).toBe(dateToSnowflake(new Date("2016-04-30T11:18:25.796Z")));
    expect(parseMessageCursor("2016-04-30T20:18:25.796+09:00")).toBe(dateToSnowflake(new Date("2016-04-30T11:18:25.796Z")));
  });

  test("treats zone-less datetimes and plain dates as UTC", () => {
    expect(parseMessageCursor("2026-10-12T00:00:00")).toBe(dateToSnowflake(new Date("2026-10-12T00:00:00Z")));
    expect(parseMessageCursor("2026-10-12")).toBe(dateToSnowflake(new Date("2026-10-12T00:00:00Z")));
  });

  test("rejects garbage", () => {
    expect(() => parseMessageCursor("yesterday")).toThrow();
    expect(() => parseMessageCursor("12345")).toThrow();
  });
});
