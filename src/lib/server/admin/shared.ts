export interface Option {
  value: string;
  label: string;
}

/** Outcome of an admin action, shown as a toast (or a banner without JavaScript). */
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

export function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}
