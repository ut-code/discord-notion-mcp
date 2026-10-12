import { DASHBOARD_PATH } from "../../paths";

const DEFAULT_NEXT_PATH = DASHBOARD_PATH;

/** Only the resolved origin is compared, so any fixed base works. */
const BASE = new URL("http://localhost");

/** Browsers treat "\" like "/" and drop tabs and newlines, so "/\evil" or "/\t/evil" would become "//evil". */
const UNSAFE_CHARACTER = /[\u0000-\u001f\u007f\\]/;

/**
 * Returns `value` when it is a path on this site, else the dashboard. Rules:
 * 1. a root-relative path: starts with exactly one "/" ("//host" is scheme-relative);
 * 2. no backslashes or control characters;
 * 3. resolved against a fixed base, it stays on that base's origin.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return DEFAULT_NEXT_PATH;
  if (UNSAFE_CHARACTER.test(value)) return DEFAULT_NEXT_PATH;
  return URL.parse(value, BASE)?.origin === BASE.origin ? value : DEFAULT_NEXT_PATH;
}
