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
  | { event: "audit_pending_marked_failed"; count: number }
  | { event: "tool_calls_pruned"; deleted: number }
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
  | { event: "access_resolution_failed"; source: "mcp" | "dashboard"; discordUserId: string; error: string }
  | { event: "membership_check_failed"; error: string }
  | { event: "admin_lookup_failed"; lookup: "user"; userId: string; error: string }
  | { event: "admin_lookup_failed"; lookup: "member_search"; error: string }
  | { event: "sign_out_failed"; error: string }
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
