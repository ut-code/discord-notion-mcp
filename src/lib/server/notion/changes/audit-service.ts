import type { NotionAuditRow } from "../../db/schema";
import { errorMessage } from "../../lib/errors";
import { isNotionMiss, NotionRequestError, type NotionApi, type NotionPage, type PageMarkdown } from "../client/api";
import { sha256 } from "../content/content-diff";
import { toWritablePropertyValue } from "../content/properties";
import { postComment, revertCommentText } from "./attribution";
import {
  ArchivePageSnapshotSchema,
  ContentSnapshotSchema,
  CreatePageResultSchema,
  UpdatePropertiesSnapshotSchema,
  type ContentSnapshot,
  type CreatePageResult,
  type UpdatePropertiesSnapshot,
} from "./audit-records";
import type { AuditActor, AuditListQuery, AuditListResult, NotionAuditStore } from "./audit-store";

const MAX_AUDIT_PAGE_SIZE = 200;

/** Rows still pending after this long belong to a write the server never finished. */
export const STALE_PENDING_MS = 10 * 60_000;
export const INTERRUPTED_ERROR = "interrupted (server restarted)";

export interface RevertOptions {
  actorDiscordUserId: string;
  actorDisplayName: string;
  actorUsername?: string | null;
  /** Revert even when the page changed after the original write (admin UI only). */
  force?: boolean;
}

export interface RevertResult {
  ok: boolean;
  /** Some property values could not be restored; the rest were. */
  partial?: boolean;
  /** Refused because the page changed after the write; retrying with `force` reverts anyway. */
  conflict?: boolean;
  message: string;
  revertAuditId?: number;
}

interface Executed {
  result: Record<string, unknown>;
  note: string | null;
  partial: boolean;
  commentError: string | null;
  lastEditedTime: string | null;
}

/** The persisted JSON of a revertible row, validated per operation. */
type RevertRecord =
  | { operation: "create_page"; result: CreatePageResult }
  | { operation: "append_content" | "edit_content"; snapshot: ContentSnapshot }
  | { operation: "update_properties"; snapshot: UpdatePropertiesSnapshot }
  | { operation: "archive_page" };

function parseRevertRecord(row: NotionAuditRow): RevertRecord | null {
  switch (row.operation) {
    case "create_page": {
      const result = CreatePageResultSchema.safeParse(row.result);
      return result.success ? { operation: row.operation, result: result.data } : null;
    }
    case "append_content":
    case "edit_content": {
      const snapshot = ContentSnapshotSchema.safeParse(row.snapshot);
      return snapshot.success ? { operation: row.operation, snapshot: snapshot.data } : null;
    }
    case "update_properties": {
      const snapshot = UpdatePropertiesSnapshotSchema.safeParse(row.snapshot);
      return snapshot.success ? { operation: row.operation, snapshot: snapshot.data } : null;
    }
    case "archive_page":
      return ArchivePageSnapshotSchema.safeParse(row.snapshot).success ? { operation: row.operation } : null;
    case "revert":
      return null;
  }
}

/**
 * Detects edits made after our write. Notion reports last_edited_time truncated to
 * the minute, and our attribution comment does not change it; we additionally store
 * the time read back after the comment was posted, so any later value means someone
 * (or something) edited the page afterwards. Edits within the same minute as our
 * write cannot be detected.
 */
function describeConflict(row: NotionAuditRow, current: NotionPage): string | null {
  if (!row.resultLastEditedTime) {
    return `Audit #${row.id} has no recorded last_edited_time, so later edits cannot be ruled out.`;
  }
  const recorded = Date.parse(row.resultLastEditedTime);
  const now = Date.parse(current.last_edited_time);
  if (Number.isNaN(recorded) || Number.isNaN(now) || now <= recorded) return null;
  return `The page was edited after audit #${row.id} (last_edited_time ${row.resultLastEditedTime} at the time of the write, now ${current.last_edited_time}); reverting may undo or conflict with those later changes.`;
}

type ContentCheck = { refusal: string } | { refusal: null; conflict: string | null };

/**
 * Content writes are compared by content hash instead of last_edited_time: the inverse
 * edit is only guaranteed to apply to exactly the markdown our write produced.
 */
async function checkContent(api: NotionApi, row: NotionAuditRow, snapshot: ContentSnapshot, pageId: string): Promise<ContentCheck> {
  if (snapshot.revertBlocker) return { refusal: `Audit #${row.id} cannot be reverted automatically: ${snapshot.revertBlocker}.` };
  if (!snapshot.inverse) return { refusal: null, conflict: null };
  let current: PageMarkdown;
  try {
    current = await api.retrievePageMarkdown(pageId);
  } catch (error) {
    if (isNotionMiss(error)) return { refusal: "The page is no longer accessible to the integration." };
    throw error;
  }
  if (current.truncated) return { refusal: `The page is now too large to revert audit #${row.id} automatically.` };
  if (sha256(current.markdown) === snapshot.afterSha256) return { refusal: null, conflict: null };
  return {
    refusal: null,
    conflict: `The page content changed after audit #${row.id}; reverting may fail or undo those later changes.`,
  };
}

/** Audit log queries and revert, used by the admin UI and the change tools. */
export class NotionAuditService {
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly store: NotionAuditStore,
    private readonly api: NotionApi | null,
  ) {}

  listAudit(query: Partial<AuditListQuery> = {}): Promise<AuditListResult> {
    return this.store.list({
      ...query,
      limit: Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), MAX_AUDIT_PAGE_SIZE),
      offset: Math.max(Math.trunc(query.offset ?? 0), 0),
    });
  }

  getAudit(id: number): Promise<NotionAuditRow | null> {
    return this.store.get(id);
  }

  listActors(): Promise<AuditActor[]> {
    return this.store.listActors();
  }

  /** Marks writes left pending by a previous process as failed; returns how many were marked. */
  failInterruptedWrites(now: Date = new Date()): Promise<number> {
    return this.store.failPendingBefore(new Date(now.getTime() - STALE_PENDING_MS), INTERRUPTED_ERROR);
  }

  async revert(id: number, options: RevertOptions): Promise<RevertResult> {
    if (this.inFlight.has(id)) return { ok: false, message: `A revert of audit #${id} is already in progress.` };
    this.inFlight.add(id);
    try {
      return await this.revertOnce(id, options);
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async revertOnce(id: number, options: RevertOptions): Promise<RevertResult> {
    const api = this.api;
    if (!api) return { ok: false, message: "Notion is not configured (NOTION_TOKEN is not set)." };
    const row = await this.store.get(id);
    if (!row) return { ok: false, message: `Audit #${id} not found.` };
    if (row.operation === "revert") return { ok: false, message: "Reverting a revert is not supported." };
    if (row.status !== "ok") {
      return { ok: false, message: `Audit #${id} is ${row.status === "failed" ? "a failed write" : "still pending"}; there is nothing to revert.` };
    }
    if (row.revertedAt) {
      return {
        ok: false,
        message: `Audit #${id} was already reverted at ${row.revertedAt.toISOString()} (revert audit #${row.revertAuditId ?? "?"}).`,
      };
    }
    if (!row.targetPageId) return { ok: false, message: `Audit #${id} has no target page.` };
    const record = parseRevertRecord(row);
    if (!record) {
      return { ok: false, message: `Audit #${id} has an unrecognized snapshot format; it cannot be reverted automatically.` };
    }

    let current: NotionPage;
    try {
      current = await api.retrievePage(row.targetPageId);
    } catch (error) {
      if (isNotionMiss(error)) return { ok: false, message: "The page is no longer accessible to the integration." };
      throw error;
    }
    let conflict: string | null;
    if (record.operation === "append_content" || record.operation === "edit_content") {
      const check = await checkContent(api, row, record.snapshot, current.id);
      if (check.refusal !== null) return { ok: false, message: check.refusal };
      conflict = check.conflict;
    } else {
      conflict = describeConflict(row, current);
    }
    if (conflict && !options.force) return { ok: false, conflict: true, message: conflict };

    const comment = revertCommentText(options.actorDisplayName, row.id);
    let executed: Executed;
    try {
      executed = await this.execute(api, row, record, current, comment);
    } catch (error) {
      await this.store.insert({
        ...this.revertColumns(row, options),
        status: "failed",
        error: errorMessage(error),
      });
      return { ok: false, message: `Revert of audit #${id} failed: ${errorMessage(error)}` };
    }

    const revertRow = await this.store.insert({
      ...this.revertColumns(row, options),
      result: executed.result,
      status: "ok",
      error: executed.partial ? executed.note : null,
      commentError: executed.commentError,
      resultLastEditedTime: executed.lastEditedTime,
    });
    await this.store.update(row.id, {
      revertedAt: new Date(),
      revertedBy: options.actorDiscordUserId,
      revertAuditId: revertRow.id,
      revertNote: executed.note,
    });
    const forced = conflict ? " (forced despite later edits)" : "";
    const message = executed.note
      ? `Reverted audit #${id}${forced}: ${executed.note}`
      : `Reverted audit #${id}${forced}.`;
    return { ok: true, ...(executed.partial ? { partial: true } : {}), message, revertAuditId: revertRow.id };
  }

  private revertColumns(row: NotionAuditRow, options: RevertOptions) {
    return {
      discordUserId: options.actorDiscordUserId,
      discordDisplayName: options.actorDisplayName,
      discordUsername: options.actorUsername ?? null,
      operation: "revert" as const,
      targetPageId: row.targetPageId,
      targetUrl: row.targetUrl,
      targetTitle: row.targetTitle,
      request: { auditId: row.id, force: options.force ?? false },
      revertOfAuditId: row.id,
    };
  }

  private async execute(api: NotionApi, row: NotionAuditRow, record: RevertRecord, current: NotionPage, comment: string): Promise<Executed> {
    const pageId = current.id;
    switch (record.operation) {
      case "create_page": {
        // Comment first: a trashed page may not accept comments.
        const commentError = current.in_trash ? null : await postComment(api, pageId, comment);
        if (current.in_trash) {
          return { result: { inTrash: true }, note: "The page was already in the trash.", partial: false, commentError, lastEditedTime: current.last_edited_time };
        }
        const trashed = await api.updatePage({ pageId: record.result.pageId, inTrash: true });
        return { result: { inTrash: true }, note: null, partial: false, commentError, lastEditedTime: trashed.last_edited_time };
      }
      case "append_content":
      case "edit_content": {
        const { snapshot } = record;
        if (!snapshot.inverse) {
          const commentError = await postComment(api, pageId, comment);
          return {
            result: { restored: false },
            note: "The change did not alter the page content; nothing to restore.",
            partial: false,
            commentError,
            lastEditedTime: await this.lastEdited(api, pageId),
          };
        }
        let restored: PageMarkdown;
        try {
          restored = await api.updatePageMarkdown(pageId, snapshot.inverse);
        } catch (error) {
          if (error instanceof NotionRequestError && error.status === 400) {
            throw new Error(
              `The page no longer contains the text written by audit #${row.id} in its original form, so it cannot be reverted automatically; restore it by hand. (Notion: ${error.message})`,
            );
          }
          throw error;
        }
        const commentError = await postComment(api, pageId, comment);
        const contentSha256 = restored.truncated ? null : sha256(restored.markdown);
        const note =
          contentSha256 !== null && contentSha256 !== snapshot.beforeSha256
            ? "The restored content is not identical to the content before the change (later edits or Notion formatting)."
            : null;
        return {
          result: { restored: true, contentSha256 },
          note,
          partial: false,
          commentError,
          lastEditedTime: await this.lastEdited(api, pageId),
        };
      }
      case "update_properties": {
        const properties: Record<string, unknown> = {};
        const restored: string[] = [];
        const skipped: string[] = [];
        for (const entry of record.snapshot.properties) {
          const writable = toWritablePropertyValue(entry.value);
          if (writable.ok) {
            properties[entry.id] = writable.value;
            restored.push(entry.name);
          } else {
            skipped.push(`"${entry.name}" (${writable.reason})`);
          }
        }
        if (restored.length === 0) throw new Error(`No property could be restored: ${skipped.join("; ")}`);
        const updated = await api.updatePage({ pageId, properties });
        const commentError = await postComment(api, pageId, comment);
        const partial = skipped.length > 0;
        const note = partial ? `Restored ${restored.join(", ")}; could not restore ${skipped.join("; ")}.` : null;
        return {
          result: { restored, skipped },
          note,
          partial,
          commentError,
          lastEditedTime: (await this.lastEdited(api, pageId)) ?? updated.last_edited_time,
        };
      }
      case "archive_page": {
        if (!current.in_trash) {
          return {
            result: { inTrash: false },
            note: "The page was already restored from the trash.",
            partial: false,
            commentError: null,
            lastEditedTime: current.last_edited_time,
          };
        }
        const restoredPage = await api.updatePage({ pageId, inTrash: false });
        const commentError = await postComment(api, pageId, comment);
        return { result: { inTrash: false }, note: null, partial: false, commentError, lastEditedTime: restoredPage.last_edited_time };
      }
    }
  }

  private async lastEdited(api: NotionApi, pageId: string): Promise<string | null> {
    const page = await api.retrievePage(pageId).catch(() => null);
    return page?.last_edited_time ?? null;
  }
}
