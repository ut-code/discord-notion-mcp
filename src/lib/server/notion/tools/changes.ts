import { z } from "zod";
import type { NotionAuditRow } from "../../db/schema";
import { ToolError } from "../../lib/errors";
import { snowflakeSchema } from "../../lib/snowflake";
import { defineTool, type AnyToolDefinition } from "../../mcp/registry";
import { dashboardAuditPath } from "../../../paths";
import { actorOf } from "../changes/attribution";
import type { NotionAuditService } from "../changes/audit-service";

export interface NotionChangeToolDeps {
  audit: NotionAuditService;
  /** Origin of the dashboard, for links in tool messages; relative paths are used when unset. */
  publicUrl?: string;
}

function describeRow(row: NotionAuditRow, withUser: boolean): string {
  const parts = [`- #${row.id} ${row.createdAt.toISOString()}`, row.operation, row.status];
  if (withUser) parts.push(`by ${row.discordDisplayName} (${row.discordUserId})`);
  if (row.revertOfAuditId !== null) parts.push(`reverts #${row.revertOfAuditId}`);
  if (row.revertedAt) parts.push(`reverted ${row.revertedAt.toISOString()} (revert #${row.revertAuditId ?? "?"})`);
  const line = parts.join(" | ");
  return row.targetUrl ? `${line}\n  ${row.targetUrl}` : line;
}

function notAccessible(id: number): ToolError {
  return new ToolError(`Audit #${id} not found or not accessible.`);
}

/** Lets members review and revert their own Notion writes (admins: anyone's). */
export function createNotionChangeTools(deps: NotionChangeToolDeps): AnyToolDefinition[] {
  const { audit } = deps;
  const auditUrl = (id: number) => `${deps.publicUrl ?? ""}${dashboardAuditPath(id)}`;

  const listRecentChanges = defineTool({
    name: "notion_list_recent_changes",
    title: "List recent Notion changes",
    description:
      "List your recent Notion writes from the audit log, newest first (audit id, time, operation, status, target URL, whether reverted). Use the audit id with notion_revert_change. Admins may list all users' changes.",
    permission: "notion:write",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(10).describe("Max entries (1-50)"),
      all_users: z.boolean().optional().describe("Admins only: list changes of every user"),
      discord_user_id: snowflakeSchema.optional().describe("Admins only: list changes of this Discord user"),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (args, { principal }) => {
      const isAdmin = principal.access.isAdmin;
      const otherUser = args.discord_user_id !== undefined && args.discord_user_id !== principal.discordUserId;
      if (!isAdmin && (args.all_users || otherUser)) {
        throw new ToolError("Only admins can list other users' changes.");
      }
      const discordUserId = args.all_users ? undefined : (args.discord_user_id ?? principal.discordUserId);
      const { rows, total } = await audit.listAudit({ discordUserId, limit: args.limit });
      if (rows.length === 0) return "No Notion changes found.";
      const scope = discordUserId === undefined ? "all users" : discordUserId === principal.discordUserId ? "you" : `user ${discordUserId}`;
      const header = `${rows.length} of ${total} change(s) by ${scope}, newest first:`;
      return [header, ...rows.map((row) => describeRow(row, discordUserId !== principal.discordUserId))].join("\n");
    },
  });

  const revertChange = defineTool({
    name: "notion_revert_change",
    title: "Revert a Notion change",
    description:
      "Revert one of your Notion writes by its audit id (admins: anyone's). A created page is moved to the trash, appended or edited content is put back to its previous text, previous property values are restored, an archived page is restored. If the page was edited after the change the revert is refused; only an admin can force it, from the dashboard.",
    permission: "notion:write",
    inputSchema: z.object({
      audit_id: z.number().int().positive().describe("Audit id (see notion_list_recent_changes)"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args, { principal }) => {
      const row = await audit.getAudit(args.audit_id);
      if (!row || (!principal.access.isAdmin && row.discordUserId !== principal.discordUserId)) {
        throw notAccessible(args.audit_id);
      }
      const actor = actorOf(principal);
      const result = await audit.revert(row.id, {
        actorDiscordUserId: actor.discordUserId,
        actorDisplayName: actor.displayName,
        actorUsername: actor.username,
      });
      if (result.ok) return result.message;
      if (result.conflict) {
        throw new ToolError(
          `Not reverted: the page changed after the write. ${result.message} An admin can force the revert from the dashboard at ${auditUrl(row.id)}.`,
        );
      }
      throw new ToolError(result.message);
    },
  });

  return [listRecentChanges, revertChange];
}
