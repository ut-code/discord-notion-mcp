import { describe, expect, test } from "bun:test";
import { createLimiter } from "../../src/lib/server/lib/limiter";
import { parseNotionId, requireNotionId } from "../../src/lib/server/notion/client/ids";

const COMPACT = "1429989fe8ac4effbc8f57f56486db54";
const DASHED = "1429989f-e8ac-4eff-bc8f-57f56486db54";
const BLOCK = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
const BLOCK_DASHED = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("parseNotionId", () => {
  test("accepts raw ids with or without dashes, any case", () => {
    expect(parseNotionId(COMPACT)).toBe(DASHED);
    expect(parseNotionId(DASHED)).toBe(DASHED);
    expect(parseNotionId(COMPACT.toUpperCase())).toBe(DASHED);
    expect(parseNotionId(`  ${COMPACT}  `)).toBe(DASHED);
  });

  test("extracts the trailing id from page URLs", () => {
    expect(parseNotionId(`https://www.notion.so/myteam/Meeting-Notes-${COMPACT}`)).toBe(DASHED);
    expect(parseNotionId(`https://notion.so/${COMPACT}`)).toBe(DASHED);
    expect(parseNotionId(`https://www.notion.so/${COMPACT}?v=${BLOCK}`)).toBe(DASHED);
    expect(parseNotionId(`https://team.notion.site/Public-Page-${COMPACT}`)).toBe(DASHED);
    expect(parseNotionId(`https://www.notion.so/%E8%AD%B0%E4%BA%8B%E9%8C%B2-${COMPACT}`)).toBe(DASHED);
    // A title with a broken %-escape does not hide the id.
    expect(parseNotionId(`https://www.notion.so/%E0%A4-${COMPACT}`)).toBe(DASHED);
    // The app's own address bar.
    expect(parseNotionId(`https://app.notion.com/p/${COMPACT}`)).toBe(DASHED);
    expect(parseNotionId(`https://www.notion.com/myteam/Meeting-Notes-${COMPACT}`)).toBe(DASHED);
  });

  test("prefers the peeked page (?p=) over the path", () => {
    expect(parseNotionId(`https://www.notion.so/${BLOCK}?v=x&p=${COMPACT}&pm=s`)).toBe(DASHED);
    expect(parseNotionId(`https://app.notion.com/p/${BLOCK}?v=x&p=${COMPACT}&pm=s`)).toBe(DASHED);
  });

  test("uses the #block anchor only when allowed", () => {
    const url = `https://www.notion.so/Page-${COMPACT}#${BLOCK}`;
    expect(parseNotionId(url)).toBe(DASHED);
    expect(parseNotionId(url, { allowBlockAnchor: true })).toBe(BLOCK_DASHED);
  });

  test("rejects non-Notion hosts and garbage", () => {
    expect(parseNotionId(`https://example.com/${COMPACT}`)).toBeNull();
    expect(parseNotionId(`https://evilnotion.com/${COMPACT}`)).toBeNull();
    expect(parseNotionId(`https://notion.com.evil.example/${COMPACT}`)).toBeNull();
    expect(parseNotionId(`https://notion.so@evil.example/${COMPACT}`)).toBeNull();

    expect(parseNotionId("not an id")).toBeNull();
    expect(parseNotionId("1429989fe8ac4eff")).toBeNull();
    expect(parseNotionId("https://www.notion.so/")).toBeNull();
    expect(() => requireNotionId("nope", "page")).toThrow('Invalid "page"');
  });
});

describe("createLimiter", () => {
  test("never runs more than max tasks at once and preserves results", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active--;
          return index;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("releases the slot when a task throws", async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await limit(async () => "ok")).toBe("ok");
  });
});
