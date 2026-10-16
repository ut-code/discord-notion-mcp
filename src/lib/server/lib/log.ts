import type { ToolCallErrorKind } from "../db/schema";
import type { Permission, SubjectType } from "../permissions/permissions";

type BetterAuthLog<Level extends string> = { event: "better_auth"; level: Level; message: string; details?: unknown[] };

export type ToolCallLogEntry = {
  event: "tool_call";
  discordUserId: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  errorKind?: ToolCallErrorKind;
  error?: string;
};

type GrantChange = { permission: Permission; subjectType: SubjectType; subjectId: string; by: string };

/** Startup, maintenance and admin actions (stdout). */
export type EventEntry =
  | { event: "startup"; port: number; publicUrl: string; mcpResource: string; tools: string[] }
  | { event: "notion_disabled"; reason: string }
  | { event: "cross_origin_write_refused"; method: string; path: string; origin: string | null }
  | { event: "audit_pending_interrupted"; count: number }
  | { event: "tool_calls_pruned"; deleted: number }
  | { event: "oauth_clients_pruned"; deleted: number }
  | ToolCallLogEntry
  | ({ event: "grant_added" } & GrantChange)
  | ({ event: "grant_removed" } & GrantChange)
  | { event: "tokens_revoked"; userId: string; by: string; sessions: number; refreshTokens: number; accessTokens: number }
  | { event: "audit_revert"; auditId: number; by: string; force: boolean; ok: boolean; revertAuditId?: number; error?: string }
  | BetterAuthLog<"debug" | "info" | "warn">;

/** Unexpected failures (stderr). */
export type ErrorEntry =
  | { event: "http_error"; path: string; error: string }
  | { event: "mcp_error"; error: string }
  | { event: "tool_crash"; tool: string; error: string }
  | { event: "tool_call_record_failed"; tool: string; error: string }
  | { event: "tool_call_prune_failed"; error: string }
  | { event: "oauth_client_prune_failed"; error: string }
  | { event: "audit_sweep_failed"; error: string }
  | { event: "notion_readback_failed"; pageId: string; error: string }
  | { event: "notion_comment_retract_failed"; pageId: string; commentId: string; error: string }
  | { event: "access_resolution_failed"; source: "mcp" | "dashboard" | "consent"; discordUserId: string; error: string }
  | { event: "membership_check_failed"; error: string }
  | { event: "admin_lookup_failed"; lookup: "user"; userId: string; error: string }
  | { event: "admin_lookup_failed"; lookup: "member_list" | "member_search"; error: string }
  | { event: "admin_lookup_failed"; lookup: "avatar"; userId: string; error: string }
  | { event: "sign_out_failed"; error: string }
  | { event: "sign_in_lookup_failed"; lookup: "guild" | "client"; error: string }
  | BetterAuthLog<"error">;

export type EventSink = (entry: EventEntry) => void;
export type ErrorSink = (entry: ErrorEntry) => void;

function line(entry: EventEntry | ErrorEntry): string {
  return JSON.stringify({ ts: new Date().toISOString(), ...entry });
}

/** One JSON line per event on stdout. */
export function logEvent(entry: EventEntry): void {
  console.log(line(entry));
}

/** One JSON line per error on stderr. */
export function logError(entry: ErrorEntry): void {
  console.error(line(entry));
}
