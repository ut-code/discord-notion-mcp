import type { Permission } from "../permissions/permissions";
import type { NotionAuditOperation } from "../db/schema";
import { isRecord } from "../../guards";
import { formatNumber } from "../../locale";
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

/** A moment as Japan's wall-clock time. */
function jst(date: Date): Temporal.ZonedDateTime {
  return date.toTemporalInstant().toZonedDateTimeISO("Asia/Tokyo");
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** A tool call's duration, e.g. "389 ms" or "1.5 s". */
export function formatDuration(ms: number): string {
  return ms < 1000
    ? `${formatNumber(Math.round(ms))} ms`
    : `${formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

const VISIBLE_ROLES = 2;

/** Role names on one line: the first two, then how many more. */
export function roleSummary(names: readonly string[]): string {
  if (names.length <= VISIBLE_ROLES) return names.join(", ");
  return m.roles_more({ roles: names.slice(0, VISIBLE_ROLES).join(", "), count: formatNumber(names.length - VISIBLE_ROLES) });
}

/** Japan time, e.g. "2026/10/12 23:03:00". */
export function formatJst(date: Date | null | undefined): string {
  if (!date) return "—";
  const t = jst(date);
  return `${t.year}/${pad2(t.month)}/${pad2(t.day)} ${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`;
}

/** Japan time without year and seconds, e.g. "10/12 23:03". */
export function formatShortJst(date: Date | null | undefined): string {
  if (!date) return "—";
  const t = jst(date);
  return `${pad2(t.month)}/${pad2(t.day)} ${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** Japan date without year, e.g. "10/12". */
export function formatMonthDayJst(date: Date): string {
  const t = jst(date);
  return `${pad2(t.month)}/${pad2(t.day)}`;
}

/** Japan date, e.g. "2026/10/12". */
export function formatDateJst(date: Date | null | undefined): string {
  if (!date) return "—";
  const t = jst(date);
  return `${t.year}/${pad2(t.month)}/${pad2(t.day)}`;
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
