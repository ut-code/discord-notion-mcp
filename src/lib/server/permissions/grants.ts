import { and, eq, inArray, or } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { grants, type GrantRow } from "../db/schema";
import type { Permission, SubjectType } from "./permissions";

export interface GrantInput {
  permission: Permission;
  subjectType: SubjectType;
  subjectId: string;
  createdBy?: string | null;
}

/** What identifies a grant: one permission for one subject. */
export type GrantKey = Pick<GrantInput, "permission" | "subjectType" | "subjectId">;

export interface GrantLookup {
  /** Permissions granted directly to the user or to any of the given role ids. */
  permissionsFor(userId: string, roleIds: readonly string[]): Promise<Set<Permission>>;
}

export class GrantStore implements GrantLookup {
  constructor(private readonly db: AppDatabase) {}

  async permissionsFor(userId: string, roleIds: readonly string[]): Promise<Set<Permission>> {
    const userMatch = and(eq(grants.subjectType, "user"), eq(grants.subjectId, userId));
    const condition =
      roleIds.length > 0 ? or(userMatch, and(eq(grants.subjectType, "role"), inArray(grants.subjectId, [...roleIds]))) : userMatch;
    const rows = await this.db.select({ permission: grants.permission }).from(grants).where(condition);
    return new Set(rows.map((row) => row.permission));
  }

  /** Idempotent: an existing grant is returned as stored, with `created: false`. */
  async createGrant(input: GrantInput): Promise<{ grant: GrantRow; created: boolean }> {
    const inserted = await this.db
      .insert(grants)
      .values({
        permission: input.permission,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { grant: inserted[0], created: true };
    const existing = await this.db
      .select()
      .from(grants)
      .where(
        and(eq(grants.permission, input.permission), eq(grants.subjectType, input.subjectType), eq(grants.subjectId, input.subjectId)),
      );
    if (!existing[0]) throw new Error("Grant insert conflicted but no existing row was found");
    return { grant: existing[0], created: false };
  }

  /** All or nothing, in one transaction; grants that already exist are left as stored. Returns those created. */
  createGrants(inputs: readonly GrantInput[]): Promise<GrantKey[]> {
    const created = this.db.transaction((tx) =>
      inputs.flatMap((input) => {
        const row = tx
          .insert(grants)
          .values({
            permission: input.permission,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            createdBy: input.createdBy ?? null,
          })
          .onConflictDoNothing()
          .returning({ permission: grants.permission, subjectType: grants.subjectType, subjectId: grants.subjectId })
          .get();
        return row ? [row] : [];
      }),
    );
    return Promise.resolve(created);
  }

  async removeGrant(input: GrantKey): Promise<boolean> {
    const deleted = await this.db
      .delete(grants)
      .where(and(eq(grants.permission, input.permission), eq(grants.subjectType, input.subjectType), eq(grants.subjectId, input.subjectId)))
      .returning({ id: grants.id });
    return deleted.length > 0;
  }

  async listGrants(): Promise<GrantRow[]> {
    return this.db.select().from(grants).orderBy(grants.permission, grants.subjectType, grants.subjectId);
  }
}
