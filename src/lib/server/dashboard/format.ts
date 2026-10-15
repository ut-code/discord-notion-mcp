import type { Permission } from "../permissions/permissions";
import type { NotionAuditOperation } from "../db/schema";
import { isRecord } from "../../guards";
import { m } from "../../paraglide/messages.js";

export const PERMISSION_LABELS: Record<Permission, string> = {
  "discord:read": m.permission_discord_read(),
  "notion:read": m.permission_notion_read(),
  "notion:write": m.permission_notion_write(),
  admin: m.permission_admin(),
};

/** One-sentence hints under the permission picker. */
export const PERMISSION_HINTS: Record<Permission, string> = {
  "discord:read": m.permission_hint_discord_read(),
  "notion:read": m.permission_hint_notion_read(),
  "notion:write": m.permission_hint_notion_write(),
  admin: m.permission_hint_admin(),
};

export const AUDIT_OPERATION_LABELS: Record<NotionAuditOperation, string> = {
  create_page: m.operation_create_page(),
  append_content: m.operation_append_content(),
  edit_content: m.operation_edit_content(),
  update_properties: m.operation_update_properties(),
  archive_page: m.operation_archive_page(),
  revert: m.operation_revert(),
};

/** Status filter of the audit list: row status, or rows that were reverted later. */
export const AUDIT_STATUS_FILTERS = {
  ok: m.audit_status_ok(),
  failed: m.audit_status_failed(),
  interrupted: m.audit_status_interrupted(),
  reverted: m.audit_status_reverted(),
} as const;
export type AuditStatusFilter = keyof typeof AUDIT_STATUS_FILTERS;

export function isAuditStatusFilter(value: string | undefined): value is AuditStatusFilter {
  return value !== undefined && Object.hasOwn(AUDIT_STATUS_FILTERS, value);
}

const JST_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function jstParts(date: Date): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const parts = JST_PARTS.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (value === undefined) throw new Error(`Intl.DateTimeFormat omitted the ${type} part`);
    return value;
  };
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}

/** Japan time, e.g. "2026/10/12 23:03:00". */
export function formatJst(date: Date | null | undefined): string {
  if (!date) return "—";
  const p = jstParts(date);
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Japan time without year and seconds, e.g. "10/12 23:03". */
export function formatShortJst(date: Date | null | undefined): string {
  if (!date) return "—";
  const p = jstParts(date);
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** Japan date, e.g. "2026/10/12". */
export function formatDateJst(date: Date | null | undefined): string {
  if (!date) return "—";
  const p = jstParts(date);
  return `${p.year}/${p.month}/${p.day}`;
}

export function roleColor(color: number): string | undefined {
  return color === 0 ? undefined : `#${color.toString(16).padStart(6, "0")}`;
}

/** "@name" for a role, without doubling the "@" of @everyone. */
export function roleHandle(name: string): string {
  return name.startsWith("@") ? name : `@${name}`;
}

// The request JSON is untyped: read it only through these guards.
function field(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function richTextContent(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items.map((item) => text(field(item, "plain_text")) || text(field(field(item, "text"), "content"))).join("");
}

function optionName(option: unknown): string {
  return text(field(option, "name"));
}

/**
 * Renders a property value as sent to Notion's API (the tool request), for the
 * before/after view; falls back to compact JSON for shapes it does not know.
 */
export function renderRequestedPropertyValue(type: string, raw: unknown): string {
  const value = isRecord(raw) && Object.hasOwn(raw, type) ? raw[type] : raw;
  switch (type) {
    case "title":
    case "rich_text":
      return richTextContent(value);
    case "number":
      return typeof value === "number" || typeof value === "string" ? String(value) : "";
    case "checkbox":
      return value ? "true" : "false";
    case "select":
    case "status":
      return optionName(value);
    case "multi_select":
      return Array.isArray(value) ? value.map(optionName).filter(Boolean).join(", ") : "";
    case "date": {
      const start = text(field(value, "start"));
      const end = text(field(value, "end"));
      return start && end ? `${start} → ${end}` : start;
    }
    case "url":
    case "email":
    case "phone_number":
      return text(value);
    case "people":
    case "relation":
      return Array.isArray(value) ? value.map((item) => text(field(item, "id"))).join(", ") : "";
    default: {
      const json = JSON.stringify(value) ?? "";
      return json.length > 120 ? `${json.slice(0, 120)}…` : json;
    }
  }
}
