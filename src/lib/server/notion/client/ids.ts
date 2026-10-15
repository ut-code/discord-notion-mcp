import { ToolError } from "../../lib/errors";

const COMPACT = /^[0-9a-f]{32}$/i;
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAILING_ID = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function formatNotionId(compact: string): string {
  const hex = compact.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeRaw(value: string): string | null {
  if (COMPACT.test(value) || DASHED.test(value)) return formatNotionId(value);
  return null;
}

function isNotionHost(hostname: string): boolean {
  return hostname === "notion.so" || hostname.endsWith(".notion.so") || hostname.endsWith(".notion.site") || hostname === "notion.site";
}

export interface ParseIdOptions {
  /** Use the `#block-id` fragment of a URL when present (block targets). */
  allowBlockAnchor?: boolean;
}

/**
 * Accepts a raw Notion id (with or without dashes) or a Notion URL and returns
 * the dashed lowercase id, or null when no id can be found.
 */
export function parseNotionId(input: string, options: ParseIdOptions = {}): string | null {
  const value = input.trim();
  const raw = normalizeRaw(value);
  if (raw) return raw;

  const url = URL.parse(value);
  if (!url || !isNotionHost(url.hostname)) return null;

  if (options.allowBlockAnchor && url.hash) {
    const anchor = normalizeRaw(url.hash.slice(1));
    if (anchor) return anchor;
  }
  const peek = url.searchParams.get("p");
  if (peek) {
    const peeked = normalizeRaw(peek);
    if (peeked) return peeked;
  }
  const segment = url.pathname.split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  const id = TRAILING_ID.exec(decodeURIComponent(segment))?.[1];
  return id ? formatNotionId(id) : null;
}

/** Like parseNotionId but throws a ToolError naming the offending argument. */
export function requireNotionId(input: string, field: string, options: ParseIdOptions = {}): string {
  const id = parseNotionId(input, options);
  if (!id) throw new ToolError(`Invalid "${field}": expected a Notion URL or id (32 hex characters, with or without dashes).`);
  return id;
}

/** Best-effort public URL for a page/block id when the API does not return one. */
export function notionUrlFor(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}
