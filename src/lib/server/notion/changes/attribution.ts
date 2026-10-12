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
  create_page: "ページを作成",
  append_content: "内容を追記",
  edit_content: "本文を編集",
  update_properties: "プロパティを更新",
  archive_page: "ページをアーカイブ",
};

export function writeCommentText(actor: Actor, operation: WriteOperation, auditId: number): string {
  const handle = actor.username ? ` (@${actor.username}, Discord)` : " (Discord)";
  return `🤖 ${actor.displayName}${handle} が MCP 経由で${OPERATION_LABELS[operation]}しました — audit #${auditId}`;
}

export function revertCommentText(actorDisplayName: string, auditId: number): string {
  return `↩️ ${actorDisplayName} が audit #${auditId} を取り消しました`;
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
