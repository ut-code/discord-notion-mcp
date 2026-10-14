import { m } from "../../../paraglide/messages.js";
import type { NotionAuditOperation } from "../../db/schema";
import { displayName } from "../../lib/display-name";
import { errorMessage } from "../../lib/errors";
import type { Principal } from "../../mcp/registry";
import type { NotionApi } from "../client/api";
import { literalRichText } from "../content/rich-text";

export type WriteOperation = Exclude<NotionAuditOperation, "revert">;

/** The Discord user on whose behalf a write is made. */
export interface Actor {
  discordUserId: string;
  displayName: string;
  username: string | null;
}

export function actorOf(principal: Principal): Actor {
  const member = principal.access.member;
  return { discordUserId: principal.discordUserId, displayName: displayName(member), username: member.username };
}

export const OPERATION_LABELS: Record<WriteOperation, string> = {
  create_page: m.operation_create_page(),
  append_content: m.operation_append_content(),
  edit_content: m.operation_edit_content(),
  update_properties: m.operation_update_properties(),
  archive_page: m.operation_archive_page(),
};

export function writeCommentText(actor: Actor, operation: WriteOperation, auditId: number): string {
  const handle = actor.username ? ` (@${actor.username}, Discord)` : " (Discord)";
  return m.notion_comment_write({ actor: actor.displayName, handle, operation: OPERATION_LABELS[operation], auditId });
}

export function revertCommentText(actorDisplayName: string, auditId: number): string {
  return m.notion_comment_revert({ actor: actorDisplayName, auditId });
}

/** Posts a page comment; returns the error message instead of throwing (writes must not fail on comments). */
export async function postComment(api: NotionApi, pageId: string, text: string): Promise<string | null> {
  try {
    await api.createComment({ pageId, richText: literalRichText(text) });
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}
