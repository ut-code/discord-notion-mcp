import { lt } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { toolCall, type ToolCallErrorKind } from "../db/schema";
import { errorMessage } from "../lib/errors";
import type { LogSink } from "../lib/log";

const ERROR_MAX_LENGTH = 500;
export const TOOL_CALL_RETENTION_MS = 90 * 24 * 60 * 60_000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;

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
        error: entry.error ? entry.error.slice(0, ERROR_MAX_LENGTH) : null,
      })
      .run();
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
  log: LogSink;
  logError: LogSink;
}

/** Deletes tool calls older than 90 days now and then every 24 hours; returns a stop function. */
export function startToolCallRetention({ store, now = Date.now, intervalMs = RETENTION_INTERVAL_MS, log, logError }: RetentionOptions): () => void {
  const prune = () => {
    try {
      const deleted = store.deleteBefore(new Date(now() - TOOL_CALL_RETENTION_MS));
      if (deleted > 0) log({ event: "tool_calls_pruned", deleted });
    } catch (error) {
      logError({ event: "tool_call_prune_failed", error: errorMessage(error) });
    }
  };
  prune();
  const timer = setInterval(prune, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
