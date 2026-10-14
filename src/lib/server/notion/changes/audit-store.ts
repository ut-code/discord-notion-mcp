import { and, count, desc, eq, isNotNull, isNull, lt, max, ne, or, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../../db/client";
import {
  notionAudit,
  type NewNotionAuditRow,
  type NotionAuditOperation,
  type NotionAuditRow,
  type NotionAuditStatus,
} from "../../db/schema";

/** The error of a pending row given up on at startup; a guess that the real outcome may still replace. */
export const INTERRUPTED_ERROR = "interrupted (server restarted)";

export interface AuditListQuery {
  limit: number;
  offset: number;
  discordUserId?: string;
  operation?: NotionAuditOperation;
  status?: NotionAuditStatus;
  /** true: only rows that were reverted; false: only rows that were not. */
  reverted?: boolean;
}

/** A Discord user that appears in the audit log, with the latest recorded names. */
export interface AuditActor {
  discordUserId: string;
  displayName: string;
  username: string | null;
}

export interface AuditListResult {
  rows: NotionAuditRow[];
  total: number;
}

/** A new row; the database assigns the id and the store's clock the creation time. */
export type AuditInsert = Omit<NewNotionAuditRow, "id" | "createdAt">;

/** Details known only after a successful write: the attribution comment and the final page state. */
export type AuditAttribution = Pick<NewNotionAuditRow, "commentError" | "targetUrl" | "resultLastEditedTime">;

/** How a pending write ended. */
export type PendingOutcome =
  | ({ status: "ok" } & Pick<NewNotionAuditRow, "result" | "error" | "commentError" | "resultLastEditedTime">)
  | ({ status: "failed"; error: string } & Pick<NewNotionAuditRow, "commentError">);

/** What the original row records about its revert. */
export type RevertMark = Pick<NewNotionAuditRow, "revertedBy" | "revertNote">;

/** Still open: pending, or given up on as interrupted while the write may have gone on. */
const stillOpen = (id: number) =>
  and(
    eq(notionAudit.id, id),
    or(eq(notionAudit.status, "pending"), and(eq(notionAudit.status, "failed"), eq(notionAudit.error, INTERRUPTED_ERROR))),
  );

/** The partial unique index on revert_of_audit_id: reverts that are pending or done. */
const activeRevert = sql`${notionAudit.status} <> 'failed'`;

/** The unique index on active reverts rejected an insert; other constraint errors are real failures. */
function isActiveRevertConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    error.message.includes("notion_audit.revert_of_audit_id")
  );
}

/**
 * The audit log. Rows are written once and then only move forward: a pending write ends
 * once, and a write is reverted at most once. Who did what, and when, never changes.
 */
export class NotionAuditStore {
  constructor(private readonly db: AppDatabase) {}

  async insert(row: AuditInsert): Promise<NotionAuditRow> {
    const [inserted] = await this.db.insert(notionAudit).values(row).returning();
    if (!inserted) throw new Error("Audit insert returned no row");
    return inserted;
  }

  async recordAttribution(id: number, attribution: AuditAttribution): Promise<void> {
    await this.db.update(notionAudit).set(attribution).where(eq(notionAudit.id, id));
  }

  /** Ends a pending write; false when it already ended (a real outcome is never replaced). */
  async finishPending(id: number, outcome: PendingOutcome): Promise<boolean> {
    // `error: null` first: an outcome replacing the interruption guess must not keep its marker.
    const updated = await this.db
      .update(notionAudit)
      .set({ error: null, ...outcome })
      .where(stillOpen(id))
      .returning({ id: notionAudit.id });
    return updated.length > 0;
  }

  /** Marks rows still `pending` that were created before `cutoff` as interrupted; returns how many. */
  async failPendingBefore(cutoff: Date): Promise<number> {
    const updated = await this.db
      .update(notionAudit)
      .set({ status: "failed", error: INTERRUPTED_ERROR })
      .where(and(eq(notionAudit.status, "pending"), lt(notionAudit.createdAt, cutoff)))
      .returning({ id: notionAudit.id });
    return updated.length;
  }

  /**
   * Records a revert as pending before it touches Notion; null when another revert of the same
   * row is pending or done (the unique index on revert_of_audit_id decides, across processes).
   */
  async startRevert(row: Omit<AuditInsert, "status"> & { operation: "revert"; revertOfAuditId: number }): Promise<NotionAuditRow | null> {
    try {
      return await this.insert({ ...row, status: "pending" });
    } catch (error) {
      if (isActiveRevertConflict(error)) return null;
      throw error;
    }
  }

  /**
   * Ends a pending revert successfully and marks the original reverted, atomically. False when the
   * log moved on meanwhile: the revert already ended, or it was given up on as interrupted and
   * another revert of the same row started.
   */
  finishRevert(revertId: number, originalId: number, outcome: PendingOutcome & { status: "ok" }, mark: RevertMark): Promise<boolean> {
    const finished = this.db.transaction((tx) => {
      const other = tx
        .select({ id: notionAudit.id })
        .from(notionAudit)
        .where(and(eq(notionAudit.revertOfAuditId, originalId), ne(notionAudit.id, revertId), activeRevert))
        .get();
      if (other) return false;
      const ended = tx
        .update(notionAudit)
        .set({ error: null, ...outcome })
        .where(stillOpen(revertId))
        .returning({ id: notionAudit.id })
        .all();
      if (ended.length === 0) return false;
      tx.update(notionAudit)
        .set({ ...mark, revertedAt: new Date(), revertAuditId: revertId })
        .where(and(eq(notionAudit.id, originalId), isNull(notionAudit.revertedAt)))
        .run();
      return true;
    });
    return Promise.resolve(finished);
  }

  async get(id: number): Promise<NotionAuditRow | null> {
    const [row] = await this.db.select().from(notionAudit).where(eq(notionAudit.id, id));
    return row ?? null;
  }

  /** Newest first; the page and the total come from one snapshot. */
  list(query: AuditListQuery): Promise<AuditListResult> {
    const conditions: SQL[] = [];
    if (query.discordUserId) conditions.push(eq(notionAudit.discordUserId, query.discordUserId));
    if (query.operation) conditions.push(eq(notionAudit.operation, query.operation));
    if (query.status) conditions.push(eq(notionAudit.status, query.status));
    if (query.reverted !== undefined) {
      conditions.push(query.reverted ? isNotNull(notionAudit.revertedAt) : isNull(notionAudit.revertedAt));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const result = this.db.transaction((tx) => {
      const rows = tx.select().from(notionAudit).where(where).orderBy(desc(notionAudit.id)).limit(query.limit).offset(query.offset).all();
      const totals = tx.select({ total: count() }).from(notionAudit).where(where).get();
      return { rows, total: totals?.total ?? 0 };
    });
    return Promise.resolve(result);
  }

  /** Every actor once, named as on their latest row, sorted by display name. */
  async listActors(): Promise<AuditActor[]> {
    const latest = this.db
      .select({ id: max(notionAudit.id).as("latest_id") })
      .from(notionAudit)
      .groupBy(notionAudit.discordUserId)
      .as("latest");
    return this.db
      .select({
        discordUserId: notionAudit.discordUserId,
        displayName: notionAudit.discordDisplayName,
        username: notionAudit.discordUsername,
      })
      .from(notionAudit)
      .innerJoin(latest, eq(notionAudit.id, latest.id))
      .orderBy(notionAudit.discordDisplayName, notionAudit.discordUserId);
  }
}
