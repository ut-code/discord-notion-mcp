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

export const AUDIT_OPERATION_LABELS: Record<NotionAuditOperation, string> = {
  ...OPERATION_LABELS,
  archive_page: "アーカイブ",
  revert: "取り消し",
};

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

function richTextContent(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => {
      const entry = item as { plain_text?: unknown; text?: { content?: unknown } };
      if (typeof entry.plain_text === "string") return entry.plain_text;
      return typeof entry.text?.content === "string" ? entry.text.content : "";
    })
    .join("");
}

function optionName(option: unknown): string {
  const name = (option as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "";
}

/**
 * Renders a property value as sent to Notion's API (the tool request), for the
 * before/after view; falls back to compact JSON for shapes it does not know.
 */
export function renderRequestedPropertyValue(type: string, raw: unknown): string {
  const value = raw !== null && typeof raw === "object" && type in raw ? (raw as Record<string, unknown>)[type] : raw;
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
      const date = value as { start?: unknown; end?: unknown } | null;
      if (!date || typeof date.start !== "string") return "";
      return typeof date.end === "string" ? `${date.start} → ${date.end}` : date.start;
    }
    case "url":
    case "email":
    case "phone_number":
      return typeof value === "string" ? value : "";
    case "people":
    case "relation":
      return Array.isArray(value) ? value.map((item) => String((item as { id?: unknown })?.id ?? "")).join(", ") : "";
    default: {
      const json = JSON.stringify(value) ?? "";
      return json.length > 120 ? `${json.slice(0, 120)}…` : json;
    }
  }
}
