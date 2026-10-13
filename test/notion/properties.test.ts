import { describe, expect, test } from "bun:test";
import {
  mayBeTruncated,
  renderPropertyValue,
  toWritablePropertyValue,
  valueFromPropertyItems,
  type PagePropertyValue,
} from "../../src/lib/server/notion/content/properties";
import { literalRichText, splitText } from "../../src/lib/server/notion/content/rich-text";
import { rt } from "../support/notion-fakes";

const v = (value: Record<string, unknown>) => ({ id: "pid", ...value }) as unknown as PagePropertyValue;

describe("literalRichText", () => {
  test("splits long text at 2000 characters without breaking surrogate pairs", () => {
    expect(literalRichText("")).toEqual([]);
    expect(literalRichText("**not markdown**")).toEqual([{ type: "text", text: { content: "**not markdown**" } }]);
    const long = "a".repeat(1999) + "😀" + "b".repeat(10);
    const chunks = splitText(long);
    expect(chunks.map((c) => c.length)).toEqual([1999, 12]);
    expect(chunks.join("")).toBe(long);
    expect(literalRichText("x".repeat(4500)).length).toBe(3);
  });
});

describe("toWritablePropertyValue", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      "title",
      { type: "title", title: [rt("Hello", { bold: true }), rt(" link", {}, "https://a.test")] },
      {
        title: [
          {
            type: "text",
            text: { content: "Hello", link: null },
            annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
          },
          {
            type: "text",
            text: { content: " link", link: { url: "https://a.test" } },
            annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
          },
        ],
      },
    ],
    ["number", { type: "number", number: 42 }, { number: 42 }],
    ["number (empty)", { type: "number", number: null }, { number: null }],
    ["select", { type: "select", select: { id: "opt1", name: "A", color: "red" } }, { select: { id: "opt1" } }],
    ["select (empty)", { type: "select", select: null }, { select: null }],
    [
      "multi_select",
      {
        type: "multi_select",
        multi_select: [
          { id: "a", name: "A", color: "red" },
          { id: "b", name: "B", color: "blue" },
        ],
      },
      { multi_select: [{ id: "a" }, { id: "b" }] },
    ],
    ["status", { type: "status", status: { id: "s1", name: "Done", color: "green" } }, { status: { id: "s1" } }],
    [
      "date",
      { type: "date", date: { start: "2026-10-12", end: "2026-10-13", time_zone: null } },
      { date: { start: "2026-10-12", end: "2026-10-13", time_zone: null } },
    ],
    ["date (empty)", { type: "date", date: null }, { date: null }],
    ["checkbox", { type: "checkbox", checkbox: true }, { checkbox: true }],
    ["url", { type: "url", url: "https://x.test" }, { url: "https://x.test" }],
    ["email", { type: "email", email: null }, { email: null }],
    ["phone_number", { type: "phone_number", phone_number: "+81" }, { phone_number: "+81" }],
    [
      "people",
      {
        type: "people",
        people: [
          { object: "user", id: "u1", name: "A" },
          { object: "group", id: "g1", name: "G" },
        ],
      },
      {
        people: [
          { object: "user", id: "u1" },
          { object: "group", id: "g1" },
        ],
      },
    ],
    ["relation", { type: "relation", relation: [{ id: "p1" }, { id: "p2" }], has_more: false }, { relation: [{ id: "p1" }, { id: "p2" }] }],
    [
      "files (external)",
      { type: "files", files: [{ name: "spec", type: "external", external: { url: "https://f.test/spec" } }] },
      { files: [{ name: "spec", type: "external", external: { url: "https://f.test/spec" } }] },
    ],
  ];

  for (const [name, read, write] of cases) {
    test(name, () => {
      expect(toWritablePropertyValue(v(read))).toEqual({ ok: true, value: write });
    });
  }

  test("rich_text keeps restorable mentions and degrades others to text", () => {
    const userMention = { ...rt("@A"), type: "mention", mention: { type: "user", user: { object: "user", id: "u1" } } };
    const linkMention = {
      ...rt("site", {}, "https://s.test"),
      type: "mention",
      mention: { type: "link_mention", link_mention: { href: "https://s.test" } },
    };
    const result = toWritablePropertyValue(v({ type: "rich_text", rich_text: [userMention, linkMention] }));
    expect(result.ok).toBe(true);
    const items = (result as unknown as { value: { rich_text: unknown[] } }).value.rich_text;
    expect(items[0]).toMatchObject({ type: "mention", mention: { user: { id: "u1" } } });
    expect(items[1]).toMatchObject({ type: "text", text: { content: "site", link: { url: "https://s.test" } } });
  });

  test("Notion-hosted files cannot be restored", () => {
    const result = toWritablePropertyValue(
      v({ type: "files", files: [{ name: "upload.png", type: "file", file: { url: "https://s3/x", expiry_time: "" } }] }),
    );
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, refusal: { kind: "hosted_files", files: ["upload.png"] } });
  });

  test("read-only types are rejected", () => {
    for (const type of ["formula", "rollup", "created_time", "created_by", "last_edited_time", "last_edited_by", "unique_id", "button"]) {
      expect(toWritablePropertyValue(v({ type, [type]: {} })).ok).toBe(false);
    }
  });
});

describe("renderPropertyValue", () => {
  test("renders common types as text", () => {
    expect(renderPropertyValue(v({ type: "title", title: [rt("T")] }))).toBe("T");
    expect(renderPropertyValue(v({ type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] }))).toBe("a, b");
    expect(renderPropertyValue(v({ type: "date", date: { start: "2026-01-01", end: "2026-01-02" } }))).toBe("2026-01-01 → 2026-01-02");
    expect(renderPropertyValue(v({ type: "checkbox", checkbox: false }))).toBe("false");
    expect(renderPropertyValue(v({ type: "formula", formula: { type: "number", number: 3 } }))).toBe("3");
    expect(renderPropertyValue(v({ type: "unique_id", unique_id: { prefix: "TASK", number: 7 } }))).toBe("TASK-7");
    expect(renderPropertyValue(v({ type: "people", people: [{ id: "u1", name: "Ann" }, { id: "u2" }] }))).toBe("Ann, u2");
    expect(renderPropertyValue(v({ type: "select", select: null }))).toBe("");
  });
});

describe("truncated array properties", () => {
  test("detects possibly truncated values and rebuilds them from property items", () => {
    const relation = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}` }));
    const value = v({ type: "relation", relation, has_more: true });
    expect(mayBeTruncated(value)).toBe(true);
    expect(mayBeTruncated(v({ type: "relation", relation: [{ id: "x" }], has_more: false }))).toBe(false);
    const items = Array.from({ length: 30 }, (_, i) => ({
      object: "property_item",
      id: "pid",
      type: "relation",
      relation: { id: `p${i}` },
    }));
    const full = valueFromPropertyItems(value, items as never);
    expect((full as Extract<PagePropertyValue, { type: "relation" }>).relation).toHaveLength(30);
    expect(toWritablePropertyValue(full)).toMatchObject({ ok: true, value: { relation: expect.any(Array) } });
  });
});
