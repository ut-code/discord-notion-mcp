import { and, count, desc, eq, isNotNull, isNull, lt, max, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../../db/client";
import {
  notionAudit,
  type NewNotionAuditRow,
  type NotionAuditOperation,
  type NotionAuditRow,
  type NotionAuditStatus,
} from "../../db/schema";

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

export type AuditPatch = Partial<Omit<NewNotionAuditRow, "id" | "createdAt">>;

export class NotionAuditStore {
  constructor(private readonly db: AppDatabase) {}

  async insert(row: Omit<NewNotionAuditRow, "id">): Promise<NotionAuditRow> {
    const [inserted] = await this.db.insert(notionAudit).values(row).returning();
    if (!inserted) throw new Error("Audit insert returned no row");
    return inserted;
  }

  async update(id: number, patch: AuditPatch): Promise<void> {
    await this.db.update(notionAudit).set(patch).where(eq(notionAudit.id, id));
  }

  /** Marks rows still `pending` that were created before `cutoff` as failed; returns how many. */
  async failPendingBefore(cutoff: Date, error: string): Promise<number> {
    const updated = await this.db
      .update(notionAudit)
      .set({ status: "failed", error })
      .where(and(eq(notionAudit.status, "pending"), lt(notionAudit.createdAt, cutoff)))
      .returning({ id: notionAudit.id });
    return updated.length;
  }

  async get(id: number): Promise<NotionAuditRow | null> {
    const [row] = await this.db.select().from(notionAudit).where(eq(notionAudit.id, id));
    return row ?? null;
  }

  /** Newest first. */
  async list(query: AuditListQuery): Promise<AuditListResult> {
    const conditions: SQL[] = [];
    if (query.discordUserId) conditions.push(eq(notionAudit.discordUserId, query.discordUserId));
    if (query.operation) conditions.push(eq(notionAudit.operation, query.operation));
    if (query.status) conditions.push(eq(notionAudit.status, query.status));
    if (query.reverted !== undefined) {
      conditions.push(query.reverted ? isNotNull(notionAudit.revertedAt) : isNull(notionAudit.revertedAt));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await this.db
      .select()
      .from(notionAudit)
      .where(where)
      .orderBy(desc(notionAudit.id))
      .limit(query.limit)
      .offset(query.offset);
    const [totals] = await this.db.select({ total: count() }).from(notionAudit).where(where);
    return { rows, total: totals?.total ?? 0 };
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
