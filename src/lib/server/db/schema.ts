import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { PERMISSIONS, SUBJECT_TYPES } from "../permissions/permissions";

export const grants = sqliteTable(
  "grants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    permission: text("permission", { enum: PERMISSIONS }).notNull(),
    subjectType: text("subject_type", { enum: SUBJECT_TYPES }).notNull(),
    subjectId: text("subject_id").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("grants_permission_subject_unique").on(table.permission, table.subjectType, table.subjectId)],
);

export type GrantRow = typeof grants.$inferSelect;

export const NOTION_AUDIT_OPERATIONS = [
  "create_page",
  "append_content",
  "edit_content",
  "update_properties",
  "archive_page",
  "revert",
] as const;
export type NotionAuditOperation = (typeof NOTION_AUDIT_OPERATIONS)[number];

/** `pending` is transient: an archive is recorded before its comment and the archive itself. */
export const NOTION_AUDIT_STATUSES = ["pending", "ok", "failed"] as const;
export type NotionAuditStatus = (typeof NOTION_AUDIT_STATUSES)[number];

export const notionAudit = sqliteTable(
  "notion_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    discordUserId: text("discord_user_id").notNull(),
    discordDisplayName: text("discord_display_name").notNull(),
    discordUsername: text("discord_username"),
    operation: text("operation", { enum: NOTION_AUDIT_OPERATIONS }).notNull(),
    targetPageId: text("target_page_id"),
    targetUrl: text("target_url"),
    /** Page title when the write was made, for display. */
    targetTitle: text("target_title"),
    // JSON written by earlier versions too: read it through the schemas in notion/changes/audit-records.ts.
    request: text("request", { mode: "json" }).$type<unknown>().notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<unknown>(),
    result: text("result", { mode: "json" }).$type<unknown>(),
    status: text("status", { enum: NOTION_AUDIT_STATUSES }).notNull(),
    error: text("error"),
    commentError: text("comment_error"),
    resultLastEditedTime: text("result_last_edited_time"),
    revertedAt: integer("reverted_at", { mode: "timestamp_ms" }),
    revertedBy: text("reverted_by"),
    revertAuditId: integer("revert_audit_id"),
    revertNote: text("revert_note"),
    /** On a `revert` row: the audit id it reverted. */
    revertOfAuditId: integer("revert_of_audit_id"),
  },
  (table) => [
    index("notion_audit_created_at_idx").on(table.createdAt),
    index("notion_audit_discord_user_idx").on(table.discordUserId),
    // At most one revert of a row is pending or done; failed attempts do not count.
    uniqueIndex("notion_audit_one_revert_idx")
      .on(table.revertOfAuditId)
      .where(sql`${table.status} <> 'failed'`),
  ],
);

export type NotionAuditRow = typeof notionAudit.$inferSelect;
export type NewNotionAuditRow = typeof notionAudit.$inferInsert;

export const TOOL_CALL_ERROR_KINDS = ["error", "rate_limited"] as const;
export type ToolCallErrorKind = (typeof TOOL_CALL_ERROR_KINDS)[number];

/** One row per MCP tool call, for usage statistics; arguments are never stored. */
export const toolCall = sqliteTable(
  "tool_call",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    discordUserId: text("discord_user_id").notNull(),
    tool: text("tool").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    errorKind: text("error_kind", { enum: TOOL_CALL_ERROR_KINDS }),
    /**
     * Server-composed text only: a ToolError message, the rate limit notice, or a fixed
     * string for error results returned by a tool and for crashes (never the tool output).
     */
    error: text("error"),
  },
  (table) => [
    index("tool_call_created_at_idx").on(table.createdAt),
    index("tool_call_user_created_at_idx").on(table.discordUserId, table.createdAt),
  ],
);

export type ToolCallRow = typeof toolCall.$inferSelect;
export type NewToolCallRow = typeof toolCall.$inferInsert;

/** Access tokens (JWTs) of a Better Auth user issued at or before `revokedAt` are rejected. */
export const tokenRevocation = sqliteTable("token_revocation", {
  userId: text("user_id").primaryKey(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }).notNull(),
});
