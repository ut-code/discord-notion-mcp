import { and, count, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { TOOL_CALL_ERROR_KINDS, toolCall, type ToolCallErrorKind, type ToolCallRow } from "../db/schema";
import { errorMessage } from "../lib/errors";
import type { ErrorSink, EventSink } from "../lib/log";
import { runPeriodically } from "../lib/periodic";

const ERROR_MAX_LENGTH = 500;
const DAY_MS = 24 * 60 * 60_000;
/** Days of tool calls kept; the longest statistics range (dashboard/stats.ts) shows all of them. */
export const TOOL_CALL_RETENTION_DAYS = 90;
export const TOOL_CALL_RETENTION_MS = TOOL_CALL_RETENTION_DAYS * DAY_MS;
const RETENTION_INTERVAL_MS = DAY_MS;

export interface ToolCallRecord {
  discordUserId: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  errorKind?: ToolCallErrorKind;
  error?: string;
  /** Defaults to now. */
  createdAt?: Date;
}

/** How a call ended: it ran fine, failed, or was refused by the rate limit. */
export const CALL_RESULTS = ["ok", ...TOOL_CALL_ERROR_KINDS] as const;
export type CallResult = (typeof CALL_RESULTS)[number];

export interface ToolCallQuery {
  /** Only calls of these tools. */
  tools: readonly string[];
  discordUserId?: string;
  result?: CallResult;
  limit: number;
  offset: number;
}

function resultCondition(result: CallResult): SQL {
  return result === "ok" ? eq(toolCall.ok, true) : eq(toolCall.errorKind, result);
}

/** Usage statistics source: one row per MCP tool call (never the arguments). */
export class ToolCallStore {
  constructor(private readonly db: AppDatabase) {}

  record(entry: ToolCallRecord): void {
    this.db
      .insert(toolCall)
      .values({
        createdAt: entry.createdAt ?? new Date(),
        discordUserId: entry.discordUserId,
        tool: entry.tool,
        ok: entry.ok,
        durationMs: entry.durationMs,
        errorKind: entry.ok ? null : (entry.errorKind ?? "error"),
        // By code point, so a surrogate pair (an emoji) is never cut in half.
        error: entry.error ? [...entry.error].slice(0, ERROR_MAX_LENGTH).join("") : null,
      })
      .run();
  }

  /** A page of calls, newest first, and how many match. */
  list(query: ToolCallQuery): { rows: ToolCallRow[]; total: number } {
    if (query.tools.length === 0) return { rows: [], total: 0 };
    const where = and(
      inArray(toolCall.tool, [...query.tools]),
      query.discordUserId ? eq(toolCall.discordUserId, query.discordUserId) : undefined,
      query.result ? resultCondition(query.result) : undefined,
    );
    const rows = this.db
      .select()
      .from(toolCall)
      .where(where)
      .orderBy(desc(toolCall.createdAt), desc(toolCall.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    const [row] = this.db.select({ total: count() }).from(toolCall).where(where).all();
    return { rows, total: row?.total ?? 0 };
  }

  /** Everyone with a kept call of these tools, for picking whose calls to show. */
  callers(tools: readonly string[]): string[] {
    if (tools.length === 0) return [];
    return this.db
      .selectDistinct({ discordUserId: toolCall.discordUserId })
      .from(toolCall)
      .where(inArray(toolCall.tool, [...tools]))
      .all()
      .map((row) => row.discordUserId);
  }

  /** Deletes rows created before `cutoff`; returns how many. */
  deleteBefore(cutoff: Date): number {
    return this.db.delete(toolCall).where(lt(toolCall.createdAt, cutoff)).returning({ id: toolCall.id }).all().length;
  }
}

export interface RetentionOptions {
  store: Pick<ToolCallStore, "deleteBefore">;
  now?: () => number;
  intervalMs?: number;
  log: EventSink;
  logError: ErrorSink;
}

/** Deletes tool calls older than the retention now and then every 24 hours; returns a stop function. */
export function startToolCallRetention({
  store,
  now = Date.now,
  intervalMs = RETENTION_INTERVAL_MS,
  log,
  logError,
}: RetentionOptions): () => void {
  return runPeriodically(() => {
    try {
      const deleted = store.deleteBefore(new Date(now() - TOOL_CALL_RETENTION_MS));
      if (deleted > 0) log({ event: "tool_calls_pruned", deleted });
    } catch (error) {
      logError({ event: "tool_call_prune_failed", error: errorMessage(error) });
    }
  }, intervalMs);
}
