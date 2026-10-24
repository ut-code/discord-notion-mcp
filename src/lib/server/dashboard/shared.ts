import { formatNumber } from "../../locale";
import { m } from "../../paraglide/messages.js";
import { isSnowflake } from "../lib/snowflake";

export interface Option {
  value: string;
  label: string;
}

/** Outcome of a dashboard action, shown as a toast (or a banner without JavaScript). */
export interface ActionResult {
  kind: "ok" | "warn" | "error";
  /** Null when the page itself explains the outcome. */
  message: string | null;
  /** HTTP status of a failed action; 400 when unset. */
  status?: 403;
}

/**
 * The `user` filter of a history list, which only admins may set: a Discord id, or the error to
 * show when the value is not one.
 */
export function userFilterParam(params: URLSearchParams, isAdmin: boolean): { user: string | undefined; error: string | null } {
  const value = isAdmin ? params.get("user")?.trim() : undefined;
  if (!value) return { user: undefined, error: null };
  return isSnowflake(value) ? { user: value, error: null } : { user: undefined, error: m.filter_invalid_user() };
}

export function pageParam(value: string | null | undefined): number {
  const page = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(page) && page >= 1 ? page : 1;
}

export interface PageLinks {
  /** "a–b of N"; null when the page shows no rows. */
  range: string | null;
  prevHref: string | null;
  nextHref: string | null;
}

/** Pager of a list page; past the last page, "prev" jumps back to the last page with rows. */
export function pageLinks(page: number, pageSize: number, total: number, shown: number, href: (page: number) => string): PageLinks {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = first + shown - 1;
  return {
    range: shown > 0 ? m.pager_range({ total: formatNumber(total), first: formatNumber(first), last: formatNumber(last) }) : null,
    prevHref: page > 1 ? href(Math.min(page - 1, lastPage)) : null,
    nextHref: shown > 0 && last < total ? href(page + 1) : null,
  };
}

export function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Every non-empty string sent under `key` (checkboxes of one name). */
export function formStrings(form: FormData, key: string): string[] {
  return form.getAll(key).flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []));
}
