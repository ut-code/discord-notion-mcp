import { DASHBOARD_PATH } from "../../paths";

const DEFAULT_NEXT_PATH = DASHBOARD_PATH;

const ORIGIN_PROBE = "http://next.invalid";

/** Accepts only same-origin absolute paths (no scheme-relative or backslash tricks). */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_NEXT_PATH;
  if (/[\u0000-\u001f\\]/.test(value)) return DEFAULT_NEXT_PATH;
  try {
    if (new URL(value, ORIGIN_PROBE).origin !== ORIGIN_PROBE) return DEFAULT_NEXT_PATH;
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  return value;
}
