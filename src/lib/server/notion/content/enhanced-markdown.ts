import { ToolError } from "../../lib/errors";

/** Tags that create child pages / databases, which a content revert cannot remove safely. */
const CHILD_OBJECT_TAG = /<(page|database|data-source)(?=[\s/>])/i;

const BARE_USER_MENTION = /<mention-user url="user:\/\/([^"]+)"\s*\/>/g;
const LABELED_USER_MENTION = /<mention-user url="user:\/\/([^"]+)"\s*>[^<]*<\/mention-user>/g;

/** Upper bound on user lookups per page read. */
const MAX_USER_LOOKUPS = 50;

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Throws when content would create child pages or databases. */
export function assertNoChildObjects(content: string, field: string): void {
  const match = CHILD_OBJECT_TAG.exec(content);
  if (!match) return;
  throw new ToolError(
    `"${field}" contains a <${match[1]}> tag. Creating, moving or rewriting child pages and databases through content is not allowed because it cannot be reverted safely. Create pages with notion_create_page instead, and keep existing <page>/<database> lines out of edited text.`,
  );
}

/**
 * Notion renders user mentions without a name; notion_get_page adds the name as a label.
 * Labels are removed again before writing so edits match Notion's own text.
 */
export function stripUserMentionLabels(content: string): string {
  return content.replace(LABELED_USER_MENTION, (_whole, id: string) => `<mention-user url="user://${id}"/>`);
}

/** Adds display names to unlabeled user mentions; users the lookup returns no name for keep the bare mention. */
export async function labelUserMentions(markdown: string, lookup: (userId: string) => Promise<string | null>): Promise<string> {
  const ids = [...new Set([...markdown.matchAll(BARE_USER_MENTION)].flatMap((match) => match[1] ?? []))].slice(0, MAX_USER_LOOKUPS);
  if (ids.length === 0) return markdown;
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const name = await lookup(id);
      if (name) names.set(id, name);
    }),
  );
  return markdown.replace(BARE_USER_MENTION, (whole, id: string) => {
    const name = names.get(id);
    return name ? `<mention-user url="user://${id}">${escapeText(name)}</mention-user>` : whole;
  });
}
