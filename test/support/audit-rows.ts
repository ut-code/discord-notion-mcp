import { eq } from "drizzle-orm";
import type { AppDatabase } from "../../src/lib/server/db/client";
import { notionAudit, type NewNotionAuditRow, type NotionAuditRow } from "../../src/lib/server/db/schema";

// Fixtures that write columns the store never lets callers set (backdated createdAt, damaged JSON).

export async function insertAuditRow(db: AppDatabase, row: Omit<NewNotionAuditRow, "id">): Promise<NotionAuditRow> {
  const [inserted] = await db.insert(notionAudit).values(row).returning();
  if (!inserted) throw new Error("Audit insert returned no row");
  return inserted;
}

export async function overwriteAuditRow(db: AppDatabase, id: number, values: Partial<NewNotionAuditRow>): Promise<void> {
  await db.update(notionAudit).set(values).where(eq(notionAudit.id, id));
}
