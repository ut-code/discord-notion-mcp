import { m } from "../../paraglide/messages.js";

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
    range: shown > 0 ? m.pager_range({ total, first, last }) : null,
    prevHref: page > 1 ? href(Math.min(page - 1, lastPage)) : null,
    nextHref: shown > 0 && last < total ? href(page + 1) : null,
  };
}

export function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}
