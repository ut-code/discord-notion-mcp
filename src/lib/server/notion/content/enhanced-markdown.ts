import { ToolError } from "../../lib/errors";

/**
 * Tags that create child pages / databases, which a content revert cannot remove safely.
 * They are refused anywhere, code included: Notion's code rules differ from CommonMark (any
 * ``` line closes a fence), so where code ends cannot be told. A backslash right before the
 * tag keeps it text everywhere: outside code it escapes `<`, inside code both are literal.
 */
const CHILD_OBJECT_TAG = /<(page|database|data-source)(?=[\s/>])/gi;

/**
 * A child page or database as Notion renders it in page markdown, url first (seen with API
 * version 2026-03-11; check again when it changes); text written in code has no such url.
 * Matching the url right after the name keeps the scan linear.
 */
const RENDERED_CHILD_OBJECT = /<(?:page|database|data-source)\s+url="https?:\/\//gi;

/** Whether the character at `index` follows an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (text[index - 1 - backslashes] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

/** Throws when content would create child pages or databases. */
export function assertNoChildObjects(content: string, field: string): void {
  for (const match of content.matchAll(CHILD_OBJECT_TAG)) {
    if (isEscaped(content, match.index)) continue;
    throw new ToolError(
      `"${field}" contains a <${match[1]}> tag. Creating, moving or rewriting child pages and databases through content is not allowed because it cannot be reverted safely; this includes tags inside code, which Notion may still read as tags. Create pages with notion_create_page instead, keep existing <page>/<database> lines out of edited text, and write \\<${match[1]} for the text itself.`,
    );
  }
}

/** How many child pages and databases page markdown, as Notion returns it, contains. */
export function countChildObjects(markdown: string): number {
  let count = 0;
  for (const match of markdown.matchAll(RENDERED_CHILD_OBJECT)) {
    if (!isEscaped(markdown, match.index)) count++;
  }
  return count;
}
