import type { Permission } from "../permissions/permissions";
import type { NotionAuditOperation } from "../db/schema";
import { OPERATION_LABELS } from "../notion/changes/attribution";

export const PERMISSION_LABELS: Record<Permission, string> = {
  "discord:read": "Discord 読み取り",
  "notion:read": "Notion 読み取り",
  "notion:write": "Notion 書き込み",
  admin: "管理者",
};

/** One-sentence hints under the permission picker. */
export const PERMISSION_HINTS: Record<Permission, string> = {
  "discord:read": "閲覧できるチャンネルのメッセージ・スレッド・イベントを読めます。",
  "notion:read": "Notion 連携に共有されたページ・データベースを読めます。",
  "notion:write": "ページの作成・編集・アーカイブができます。すべての操作は記録され、あとから取り消せます。",
  admin: "すべての権限に加えて、この管理画面を使えます。",
};

export const AUDIT_OPERATION_LABELS: Record<NotionAuditOperation, string> = { ...OPERATION_LABELS, revert: "取り消し" };

/** Status filter of the audit list: row status, or rows that were reverted later. */
export const AUDIT_STATUS_FILTERS = { ok: "成功", failed: "失敗", reverted: "取り消し済み" } as const;
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
  const parts: Record<string, string> = {};
  for (const part of JST_PARTS.formatToParts(date)) parts[part.type] = part.value;
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

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
      return value === null || value === undefined ? "" : String(value);
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
