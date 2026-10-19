import { ToolError } from "../../lib/errors";

/** 32 hex digits, compact or dashed 8-4-4-4-12. */
const ID = "[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RAW_ID = new RegExp(`^(?:${ID})$`, "i");
const TRAILING_ID = new RegExp(`(${ID})$`, "i");

function formatNotionId(compact: string): string {
  const hex = compact.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeRaw(value: string): string | null {
  return RAW_ID.test(value) ? formatNotionId(value) : null;
}

/** Notion's app (app.notion.com, notion.so), published sites (*.notion.site) and their subdomains. */
const NOTION_DOMAINS = ["notion.com", "notion.so", "notion.site"];

function isNotionHost(hostname: string): boolean {
  return NOTION_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
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
  // Not decoded: the id is plain hex, and only the title before it is %-escaped (or broken).
  const id = TRAILING_ID.exec(segment)?.[1];
  return id ? formatNotionId(id) : null;
}

/** Like parseNotionId but throws a ToolError naming the offending argument. */
export function requireNotionId(input: string, field: string, options: ParseIdOptions = {}): string {
  const id = parseNotionId(input, options);
  if (!id) throw new ToolError(`Invalid "${field}": expected a Notion URL or id (32 hex characters, with or without dashes).`);
  return id;
}
