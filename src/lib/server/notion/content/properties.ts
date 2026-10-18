import type { PageObjectResponse, PropertyItemObjectResponse, RichTextItemResponse } from "@notionhq/client";
import type { NotionDataSource } from "../client/api";
import { plainText } from "./rich-text";
import type { RichTextRequest } from "../client/types";

export type PagePropertyValue = PageObjectResponse["properties"][string];
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
/** A property value without its id, as nested in rollup arrays. */
type PropertyValueContent = WithoutId<PagePropertyValue>;
type FormulaValue = Extract<PropertyValueContent, { type: "formula" }>["formula"];

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

function renderFormula(formula: FormulaValue): string {
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
export function renderPropertyValue(value: PropertyValueContent): string {
  switch (value.type) {
    case "title":
      return plainText(value.title);
    case "rich_text":
      return plainText(value.rich_text);
    case "number":
      return value.number === null ? "" : String(value.number);
    case "select":
      return value.select?.name ?? "";
    case "status":
      return value.status?.name ?? "";
    case "multi_select":
      return value.multi_select.map((option) => option.name).join(", ");
    case "date":
      return renderDate(value.date);
    case "checkbox":
      return value.checkbox ? "true" : "false";
    case "url":
      return value.url ?? "";
    case "email":
      return value.email ?? "";
    case "phone_number":
      return value.phone_number ?? "";
    case "people":
      return value.people.map(userName).join(", ");
    case "relation": {
      const ids = value.relation.map((item) => item.id).join(", ");
      // Notion sends `has_more` on paginated values; the SDK types do not declare it.
      return "has_more" in value && value.has_more ? `${ids}, …` : ids;
    }
    case "files":
      return value.files.map((file) => `${file.name} (${file.type === "external" ? file.external.url : file.file.url})`).join(", ");
    case "formula":
      return renderFormula(value.formula);
    case "rollup": {
      const rollup = value.rollup;
      if (rollup.type === "number") return rollup.number === null ? "" : String(rollup.number);
      if (rollup.type === "date") return renderDate(rollup.date);
      if (rollup.type === "array") return rollup.array.map(renderPropertyValue).join(", ");
      return "";
    }
    case "created_time":
      return value.created_time;
    case "last_edited_time":
      return value.last_edited_time;
    case "created_by":
      return userName(value.created_by);
    case "last_edited_by":
      return userName(value.last_edited_by);
    case "unique_id":
      return value.unique_id.number === null
        ? ""
        : `${value.unique_id.prefix ? `${value.unique_id.prefix}-` : ""}${value.unique_id.number}`;
    case "verification":
      return value.verification?.state ?? "";
    case "place":
      return value.place ? (value.place.name ?? value.place.address ?? `${value.place.lat},${value.place.lon}`) : "";
    default:
      return "";
  }
}

/** True when the page object may have truncated this value and the full list must be fetched. */
export function mayBeTruncated(value: PagePropertyValue): boolean {
  // The array properties the page object truncates to 25 entries.
  let entries: unknown;
  switch (value.type) {
    case "title":
      entries = value.title;
      break;
    case "rich_text":
      entries = value.rich_text;
      break;
    case "people":
      entries = value.people;
      break;
    case "relation":
      entries = value.relation;
      break;
    default:
      return false;
  }
  return ("has_more" in value && value.has_more === true) || (Array.isArray(entries) && entries.length >= PAGE_PROPERTY_ITEM_LIMIT);
}

/**
 * Rebuilds a page-format property value from the paginated property item endpoint.
 * Only the paginated types (see mayBeTruncated) are rebuilt; other values are returned as is.
 */
export function valueFromPropertyItems(value: PagePropertyValue, items: readonly PropertyItemObjectResponse[]): PagePropertyValue {
  switch (value.type) {
    case "title":
      return { id: value.id, type: "title", title: items.flatMap((item) => (item.type === "title" ? [item.title] : [])) };
    case "rich_text":
      return { id: value.id, type: "rich_text", rich_text: items.flatMap((item) => (item.type === "rich_text" ? [item.rich_text] : [])) };
    case "people":
      return { id: value.id, type: "people", people: items.flatMap((item) => (item.type === "people" ? [item.people] : [])) };
    case "relation":
      return { id: value.id, type: "relation", relation: items.flatMap((item) => (item.type === "relation" ? [item.relation] : [])) };
    default:
      return value;
  }
}

function toRichTextRequest(item: RichTextItemResponse): RichTextRequest {
  const annotations = { ...item.annotations };
  if (item.type === "text") {
    return { type: "text", text: { content: item.text.content, link: item.text.link ? { url: item.text.link.url } : null }, annotations };
  }
  if (item.type === "equation") {
    return { type: "equation", equation: { expression: item.equation.expression }, annotations };
  }
  const mention = item.mention;
  switch (mention.type) {
    case "user":
      return { type: "mention", mention: { user: { id: mention.user.id } }, annotations };
    case "page":
      return { type: "mention", mention: { page: { id: mention.page.id } }, annotations };
    case "database":
      return { type: "mention", mention: { database: { id: mention.database.id } }, annotations };
    case "date":
      return { type: "mention", mention: { date: mention.date }, annotations };
    case "template_mention":
      return { type: "mention", mention: { template_mention: mention.template_mention }, annotations };
    case "custom_emoji":
      return { type: "mention", mention: { custom_emoji: { id: mention.custom_emoji.id } }, annotations };
    default:
      // Link previews and link mentions have no request form (see MentionRichTextItemRequest in
      // @notionhq/client): keep their visible text and link.
      return {
        type: "text",
        text: { content: item.plain_text, link: item.href ? { url: item.href } : null },
        annotations,
      };
  }
}

/** Why a read value cannot be written back as is. */
export type PropertyWriteRefusal = { kind: "hosted_files"; files: string[] } | { kind: "unsupported_type"; type: string };

export type WritableResult = { ok: true; value: Record<string, unknown> } | { ok: false; refusal: PropertyWriteRefusal };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Whether two read values of a property hold the same content, judged by what writing them
 * back would set (display details such as avatars or option colors are ignored). A value
 * that cannot be written back never counts as the same.
 */
export function samePropertyValue(a: PagePropertyValue, b: PagePropertyValue): boolean {
  const x = toWritablePropertyValue(a);
  const y = toWritablePropertyValue(b);
  return x.ok && y.ok && canonicalJson(x.value) === canonicalJson(y.value);
}

/** Converts a page-format (read) property value into the format pages.update accepts. */
export function toWritablePropertyValue(value: PagePropertyValue): WritableResult {
  switch (value.type) {
    case "title":
      return { ok: true, value: { title: value.title.map(toRichTextRequest) } };
    case "rich_text":
      return { ok: true, value: { rich_text: value.rich_text.map(toRichTextRequest) } };
    case "number":
      return { ok: true, value: { number: value.number ?? null } };
    case "checkbox":
      return { ok: true, value: { checkbox: value.checkbox ?? false } };
    case "url":
      return { ok: true, value: { url: value.url ?? null } };
    case "email":
      return { ok: true, value: { email: value.email ?? null } };
    case "phone_number":
      return { ok: true, value: { phone_number: value.phone_number ?? null } };
    case "select":
      return { ok: true, value: { select: value.select ? { id: value.select.id } : null } };
    case "status":
      return { ok: true, value: { status: value.status ? { id: value.status.id } : null } };
    case "multi_select":
      return { ok: true, value: { multi_select: value.multi_select.map((option) => ({ id: option.id })) } };
    case "date":
      return {
        ok: true,
        value: {
          date: value.date ? { start: value.date.start, end: value.date.end ?? null, time_zone: value.date.time_zone ?? null } : null,
        },
      };
    case "people":
      return {
        ok: true,
        value: {
          people: value.people.map((person) =>
            person.object === "group" ? { object: "group", id: person.id } : { object: "user", id: person.id },
          ),
        },
      };
    case "relation":
      return { ok: true, value: { relation: value.relation.map((item) => ({ id: item.id })) } };
    case "files": {
      const external = value.files.flatMap((file) => (file.type === "external" ? [file] : []));
      const hosted = value.files.filter((file) => file.type !== "external");
      if (hosted.length > 0) {
        return { ok: false, refusal: { kind: "hosted_files", files: hosted.map((file) => file.name) } };
      }
      return {
        ok: true,
        value: {
          files: external.map((file) => ({
            name: file.name,
            type: "external",
            external: { url: file.external.url },
          })),
        },
      };
    }
    default:
      return { ok: false, refusal: { kind: "unsupported_type", type: value.type } };
  }
}
