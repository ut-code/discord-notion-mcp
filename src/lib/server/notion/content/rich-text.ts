import type { RichTextItemResponse } from "@notionhq/client";
import type { RichTextRequest } from "../client/types";

/** Notion rejects text content longer than this per rich text item. */
const MAX_TEXT_LENGTH = 2000;

export function plainText(items: readonly RichTextItemResponse[]): string {
  return items.map((item) => item.plain_text).join("");
}

/** Splits text into chunks of at most `max` UTF-16 units without breaking surrogate pairs. */
export function splitText(text: string, max = MAX_TEXT_LENGTH): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Literal text (no Markdown parsing), split to respect the per-item length limit. */
export function literalRichText(text: string): RichTextRequest[] {
  if (!text) return [];
  return splitText(text).map((content) => ({ type: "text", text: { content } }));
}
