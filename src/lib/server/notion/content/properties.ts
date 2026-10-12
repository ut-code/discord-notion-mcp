import type { PageObjectResponse, PropertyItemObjectResponse, RichTextItemResponse } from "@notionhq/client";
import type { NotionDataSource } from "../client/api";
import { plainText } from "./rich-text";
import type { RichTextRequest } from "../client/types";

export type PagePropertyValue = PageObjectResponse["properties"][string];
/** Loosely typed view used by the type switches below (the SDK union is too deep to narrow cheaply). */
type AnyValue = Record<string, any>;

/** Property types this server can write and restore on revert. */
export const WRITABLE_PROPERTY_TYPES = new Set([
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "people",
  "relation",
  "files",
]);

/** Array properties the page object truncates to 25 entries. */
const PAGINATED_TYPES = new Set(["title", "rich_text", "people", "relation"]);
const PAGE_PROPERTY_ITEM_LIMIT = 25;

export function pageTitle(page: PageObjectResponse): string {
  for (const value of Object.values(page.properties)) {
    if (value.type === "title") return plainText(value.title) || "Untitled";
  }
  return "Untitled";
}

export function titlePropertyName(dataSource: Pick<NotionDataSource, "properties">): string | null {
  for (const [name, config] of Object.entries(dataSource.properties)) {
    if (config.type === "title") return name;
  }
  return null;
}

function userName(user: { id: string; name?: string | null }): string {
  return user.name || user.id;
}

function renderDate(date: { start: string; end: string | null } | null | undefined): string {
  if (!date) return "";
  return date.end ? `${date.start} → ${date.end}` : date.start;
}

function renderFormula(formula: Record<string, any>): string {
  switch (formula.type) {
    case "string":
      return formula.string ?? "";
    case "number":
      return formula.number === null || formula.number === undefined ? "" : String(formula.number);
    case "boolean":
      return formula.boolean === null || formula.boolean === undefined ? "" : String(formula.boolean);
    case "date":
      return renderDate(formula.date);
    default:
      return "";
  }
}

/** Renders a property value as readable single-line text (empty string when unset). */
export function renderPropertyValue(value: PagePropertyValue): string {
  const v = value as unknown as AnyValue;
  switch (v.type) {
    case "title":
    case "rich_text":
      return plainText(v[v.type] as RichTextItemResponse[]);
    case "number":
      return v.number === null ? "" : String(v.number);
    case "select":
    case "status":
      return v[v.type]?.name ?? "";
    case "multi_select":
      return v.multi_select.map((option: { name: string }) => option.name).join(", ");
    case "date":
      return renderDate(v.date);
    case "checkbox":
      return v.checkbox ? "true" : "false";
    case "url":
    case "email":
    case "phone_number":
      return v[v.type] ?? "";
    case "people":
      return v.people.map(userName).join(", ");
    case "relation": {
      const ids = v.relation.map((item: { id: string }) => item.id).join(", ");
      return v.has_more ? `${ids}, …` : ids;
    }
    case "files":
      return v.files
        .map((file: Record<string, any>) => `${file.name} (${file.type === "external" ? file.external.url : file.file.url})`)
        .join(", ");
    case "formula":
      return renderFormula(v.formula);
    case "rollup": {
      const rollup = v.rollup;
      if (rollup.type === "number") return rollup.number === null ? "" : String(rollup.number);
      if (rollup.type === "date") return renderDate(rollup.date);
      if (rollup.type === "array") return rollup.array.map((item: AnyValue) => renderPropertyValue(item as PagePropertyValue)).join(", ");
      return "";
    }
    case "created_time":
    case "last_edited_time":
      return v[v.type];
    case "created_by":
    case "last_edited_by":
      return userName(v[v.type]);
    case "unique_id":
      return v.unique_id.number === null ? "" : `${v.unique_id.prefix ? `${v.unique_id.prefix}-` : ""}${v.unique_id.number}`;
    case "verification":
      return v.verification?.state ?? "";
    case "place":
      return v.place ? (v.place.name ?? v.place.address ?? `${v.place.lat},${v.place.lon}`) : "";
    default:
      return "";
  }
}

/** True when the page object may have truncated this value and the full list must be fetched. */
export function mayBeTruncated(value: PagePropertyValue): boolean {
  const v = value as unknown as AnyValue;
  if (!PAGINATED_TYPES.has(v.type)) return false;
  return v.has_more === true || (Array.isArray(v[v.type]) && v[v.type].length >= PAGE_PROPERTY_ITEM_LIMIT);
}

/** Rebuilds a page-format property value from the paginated property item endpoint. */
export function valueFromPropertyItems(value: PagePropertyValue, items: readonly PropertyItemObjectResponse[]): PagePropertyValue {
  const type = value.type;
  const entries = items.filter((item) => item.type === type).map((item) => (item as Record<string, any>)[type]);
  return { id: value.id, type, [type]: entries } as unknown as PagePropertyValue;
}

function toRichTextRequest(item: RichTextItemResponse): RichTextRequest {
  const annotations = { ...item.annotations };
  if (item.type === "text") {
    return { type: "text", text: { content: item.text.content, link: item.text.link ? { url: item.text.link.url } : null }, annotations };
  }
  if (item.type === "equation") {
    return { type: "equation", equation: { expression: item.equation.expression }, annotations };
  }
  const mention = item.mention as Record<string, any>;
  switch (mention.type) {
    case "user":
      return { type: "mention", mention: { user: { id: mention.user.id } }, annotations };
    case "page":
      return { type: "mention", mention: { page: { id: mention.page.id } }, annotations };
    case "database":
      return { type: "mention", mention: { database: { id: mention.database.id } }, annotations };
    case "date":
      return { type: "mention", mention: { date: mention.date }, annotations };
    default:
      // Other mention kinds cannot be written back; keep their visible text (and link).
      return {
        type: "text",
        text: { content: item.plain_text, link: item.href ? { url: item.href } : null },
        annotations,
      };
  }
}

export type WritableResult = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

/** Converts a page-format (read) property value into the format pages.update accepts. */
export function toWritablePropertyValue(value: PagePropertyValue): WritableResult {
  const v = value as unknown as AnyValue;
  switch (v.type) {
    case "title":
    case "rich_text":
      return { ok: true, value: { [v.type]: (v[v.type] as RichTextItemResponse[]).map(toRichTextRequest) } };
    case "number":
    case "checkbox":
    case "url":
    case "email":
    case "phone_number":
      return { ok: true, value: { [v.type]: v[v.type] ?? (v.type === "checkbox" ? false : null) } };
    case "select":
    case "status":
      return { ok: true, value: { [v.type]: v[v.type] ? { id: v[v.type].id } : null } };
    case "multi_select":
      return { ok: true, value: { multi_select: v.multi_select.map((option: { id: string }) => ({ id: option.id })) } };
    case "date":
      return {
        ok: true,
        value: { date: v.date ? { start: v.date.start, end: v.date.end ?? null, time_zone: v.date.time_zone ?? null } : null },
      };
    case "people":
      return {
        ok: true,
        value: {
          people: v.people.map((person: { id: string; object: string }) =>
            person.object === "group" ? { object: "group", id: person.id } : { object: "user", id: person.id },
          ),
        },
      };
    case "relation":
      return { ok: true, value: { relation: v.relation.map((item: { id: string }) => ({ id: item.id })) } };
    case "files": {
      const hosted = v.files.filter((file: { type: string }) => file.type !== "external");
      if (hosted.length > 0) {
        return {
          ok: false,
          reason: `contains Notion-hosted file(s) (${hosted.map((file: { name: string }) => file.name).join(", ")}) that cannot be re-set through the API`,
        };
      }
      return {
        ok: true,
        value: {
          files: v.files.map((file: { name: string; external: { url: string } }) => ({
            name: file.name,
            type: "external",
            external: { url: file.external.url },
          })),
        },
      };
    }
    default:
      return { ok: false, reason: `property type "${v.type}" is read-only or not supported for writes` };
  }
}
