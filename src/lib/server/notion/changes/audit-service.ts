import type { NotionAuditRow } from "../../db/schema";
import { errorMessage } from "../../lib/errors";
import { logError, type ErrorSink, type EventSink } from "../../lib/log";
import { runPeriodically } from "../../lib/periodic";
import {
  isNotionMiss,
  notionFailure,
  NotionRequestError,
  writeMayHaveApplied,
  type NotionApi,
  type NotionPage,
  type PageMarkdown,
} from "../client/api";
import { sha256 } from "../content/content-diff";
import { countChildObjects } from "../content/enhanced-markdown";
import { mayBeTruncated, samePropertyValue, toWritablePropertyValue, valueFromPropertyItems } from "../content/properties";
import { postComment, retractComment, revertComment, type AttributionComment } from "./attribution";
import {
  ArchivePageSnapshotSchema,
  ContentSnapshotSchema,
  CreatePageResultSchema,
  UpdatePropertiesSnapshotSchema,
  type ContentSnapshot,
  type CreatePageResult,
  type PropertySkip,
  type RevertNote,
  type UpdatePropertiesSnapshot,
} from "./audit-records";
import type { AuditActor, AuditContent, AuditListQuery, AuditListResult, NotionAuditStore } from "./audit-store";
import { revertFailureText } from "./outcome-text";
import type { RevertConflict, RevertFailure, RevertReason, RevertResult } from "./revert-reasons";

const MAX_AUDIT_PAGE_SIZE = 200;

/** Rows still pending after this long belong to a write the server never finished. */
const STALE_PENDING_MS = 10 * 60_000;

export interface RevertOptions {
  actorDiscordUserId: string;
  actorDisplayName: string;
  actorUsername?: string | null;
}

interface Executed {
  result: Record<string, unknown>;
  note: RevertNote | null;
  /** Some property values could not be restored; the rest were. */
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

/** Thrown by execute() for failures that have a reason of their own. */
class RevertFailed extends Error {
  constructor(readonly failure: RevertFailure) {
    super(failure.kind);
  }
}

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
    default:
      throw new Error(`Unknown audit operation: ${row.operation satisfies never}`);
  }
}

/**
 * Detects edits made after our write. Notion reports last_edited_time truncated to
 * the minute, and our attribution comment does not change it; we additionally store
 * the time read back after the comment was posted, so any later value means someone
 * (or something) edited the page afterwards. Edits within the same minute as our
 * write cannot be detected.
 */
function detectConflict(row: NotionAuditRow, current: NotionPage): RevertConflict | null {
  if (!row.resultLastEditedTime) return { kind: "no_recorded_time" };
  const recorded = Date.parse(row.resultLastEditedTime);
  const now = Date.parse(current.last_edited_time);
  if (Number.isNaN(recorded) || Number.isNaN(now) || now <= recorded) return null;
  return { kind: "edited_after", recorded: row.resultLastEditedTime, now: current.last_edited_time };
}

type ContentCheck = { refusal: RevertReason } | { refusal: null; conflict: RevertConflict | null };

/**
 * Content writes are compared by content hash instead of last_edited_time: putting the content
 * before the write back undoes only that write while the page is exactly as the write left it.
 */
async function checkContent(api: NotionApi, snapshot: ContentSnapshot, pageId: string): Promise<ContentCheck> {
  if (snapshot.afterSha256 === snapshot.beforeSha256) return { refusal: null, conflict: null };
  let current: PageMarkdown;
  try {
    current = await api.retrievePageMarkdown(pageId);
  } catch (error) {
    if (isNotionMiss(error)) return { refusal: { kind: "page_inaccessible" } };
    throw error;
  }
  if (current.truncated) return { refusal: { kind: "too_large" } };
  if (sha256(current.markdown) === snapshot.afterSha256) return { refusal: null, conflict: null };
  return { refusal: null, conflict: { kind: "content_changed" } };
}

/**
 * Property writes are compared by value when the values our write left were recorded:
 * exact where last_edited_time is minute-truncated, and edits to other properties (which
 * revert does not touch) are no conflict. Undefined when a value could not be read back after
 * the write; the edit time decides then.
 */
async function checkProperties(
  api: NotionApi,
  snapshot: UpdatePropertiesSnapshot,
  current: NotionPage,
): Promise<RevertConflict | null | undefined> {
  if (!snapshot.properties.every((entry) => entry.after)) return undefined;
  const changed: string[] = [];
  for (const entry of snapshot.properties) {
    const value = Object.values(current.properties).find((candidate) => candidate.id === entry.id);
    const now =
      value && mayBeTruncated(value) ? valueFromPropertyItems(value, await api.retrievePropertyItems(current.id, value.id)) : value;
    if (!now || !entry.after || !samePropertyValue(entry.after, now)) changed.push(entry.name);
  }
  return changed.length > 0 ? { kind: "properties_changed", names: changed } : null;
}

type Prepared = { reason: RevertReason } | { reason: null; api: NotionApi; record: RevertRecord; pageId: string };

/** Audit log queries and revert, used by the dashboard and the change tools. */
export class NotionAuditService {
  constructor(
    private readonly store: NotionAuditStore,
    private readonly api: NotionApi | null,
    private readonly reportError: ErrorSink = logError,
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

  /** The page content around a successful content write, or the content of a created page; null for other rows. */
  getContent(id: number): Promise<AuditContent | null> {
    return this.store.getContent(id);
  }

  listActors(): Promise<AuditActor[]> {
    return this.store.listActors();
  }

  /** Marks writes a dead process left pending as interrupted; returns how many were marked. */
  markInterruptedWrites(now: Date = new Date()): Promise<number> {
    return this.store.interruptPendingBefore(new Date(now.getTime() - STALE_PENDING_MS));
  }

  /**
   * Why `row` cannot be reverted, judged from the stored row alone (no Notion calls);
   * null when a revert can be tried. The page may still refuse it (conflict, access).
   */
  revertability(row: NotionAuditRow): RevertReason | null {
    return this.prepare(row).reason;
  }

  private prepare(row: NotionAuditRow): Prepared {
    if (row.operation === "revert") return { reason: { kind: "is_revert" } };
    if (row.status !== "ok") return { reason: { kind: "not_ok", status: row.status } };
    if (row.revertedAt) return { reason: { kind: "already_reverted", revertedAt: row.revertedAt, revertAuditId: row.revertAuditId } };
    if (!this.api) return { reason: { kind: "notion_disabled" } };
    if (!row.targetPageId) return { reason: { kind: "no_target" } };
    const record = parseRevertRecord(row);
    if (!record) return { reason: { kind: "unrecognized_snapshot" } };
    if ((record.operation === "append_content" || record.operation === "edit_content") && record.snapshot.revertBlocker) {
      return { reason: { kind: "blocked", blocker: record.snapshot.revertBlocker } };
    }
    return { reason: null, api: this.api, record, pageId: row.targetPageId };
  }

  async revert(id: number, options: RevertOptions): Promise<RevertResult> {
    const row = await this.store.get(id);
    if (!row) return { ok: false, reason: { kind: "not_found" } };
    const prepared = this.prepare(row);
    if (prepared.reason) return { ok: false, reason: prepared.reason };
    const { api, record, pageId } = prepared;

    let current: NotionPage;
    try {
      current = await api.retrievePage(pageId);
    } catch (error) {
      if (isNotionMiss(error)) return { ok: false, reason: { kind: "page_inaccessible" } };
      throw error;
    }
    let conflict: RevertConflict | null;
    if (record.operation === "append_content" || record.operation === "edit_content") {
      const check = await checkContent(api, record.snapshot, current.id);
      if (check.refusal !== null) return { ok: false, reason: check.refusal };
      conflict = check.conflict;
    } else if (record.operation === "update_properties") {
      const checked = await checkProperties(api, record.snapshot, current);
      conflict = checked === undefined ? detectConflict(row, current) : checked;
    } else {
      conflict = detectConflict(row, current);
    }
    // Later edits are someone else's: they are left for a person to sort out by hand.
    if (conflict) return { ok: false, reason: { kind: "conflict", conflict } };
    // Edits inside child pages and databases (e.g. rows added to an inline database a template
    // brought) do not change the page's own edit time, so trashing it could take them along.
    if (record.operation === "create_page" && !current.in_trash) {
      let body: PageMarkdown;
      try {
        body = await api.retrievePageMarkdown(current.id);
      } catch (error) {
        if (isNotionMiss(error)) return { ok: false, reason: { kind: "page_inaccessible" } };
        throw error;
      }
      if (body.truncated) return { ok: false, reason: { kind: "too_large" } };
      if (countChildObjects(body.markdown) > 0) return { ok: false, reason: { kind: "has_child_objects" } };
    }

    // The content a content revert puts back; null when the write changed nothing.
    let restore: string | null = null;
    if (
      (record.operation === "append_content" || record.operation === "edit_content") &&
      record.snapshot.afterSha256 !== record.snapshot.beforeSha256
    ) {
      const content = await this.store.getContent(row.id);
      if (!content) return { ok: false, reason: { kind: "unrecognized_snapshot" } };
      restore = content.before;
    }

    // Claimed in the database before Notion is touched: a second revert of the row, from any
    // process, finds this pending row and is refused.
    const revertRow = await this.store.startRevert(this.revertColumns(row, options));
    if (!revertRow) {
      const latest = await this.store.get(row.id);
      return latest?.revertedAt
        ? { ok: false, reason: { kind: "already_reverted", revertedAt: latest.revertedAt, revertAuditId: latest.revertAuditId } }
        : { ok: false, reason: { kind: "in_progress" } };
    }

    const comment = revertComment(options.actorDisplayName, options.actorUsername ?? null, row.id);
    let executed: Executed;
    try {
      executed = await this.execute(api, record, current, comment, restore);
    } catch (error) {
      // Only the revert's own write throws here (comments and read-backs never do), so an
      // unanswered one may have been applied: interrupted, and the original stays revertible.
      if (!(error instanceof RevertFailed) && writeMayHaveApplied(error)) {
        const failure: RevertFailure = { kind: "unconfirmed", detail: notionFailure(error) };
        await this.store.finishPending(revertRow.id, { status: "interrupted", error: revertFailureText(row.id, failure) });
        return { ok: false, reason: { kind: "failed", failure, revertAuditId: revertRow.id } };
      }
      const failure: RevertFailure = error instanceof RevertFailed ? error.failure : { kind: "error", message: errorMessage(error) };
      await this.store.finishPending(revertRow.id, { status: "failed", error: revertFailureText(row.id, failure) });
      return { ok: false, reason: { kind: "failed", failure, revertAuditId: revertRow.id } };
    }

    const finished = await this.store.finishRevert(
      revertRow.id,
      row.id,
      {
        status: "ok",
        result: executed.result,
        note: executed.note,
        commentError: executed.commentError,
        resultLastEditedTime: executed.lastEditedTime,
      },
      { revertedBy: options.actorDiscordUserId, revertNote: executed.note },
    );
    if (!finished) return { ok: false, reason: { kind: "failed", failure: { kind: "superseded" }, revertAuditId: revertRow.id } };
    return { ok: true, revertAuditId: revertRow.id, partial: executed.partial, note: executed.note };
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
      request: { auditId: row.id },
      revertOfAuditId: row.id,
    };
  }

  /** `restore` is the content a content revert puts back, null when the write changed nothing. */
  private async execute(
    api: NotionApi,
    record: RevertRecord,
    current: NotionPage,
    comment: AttributionComment,
    restore: string | null,
  ): Promise<Executed> {
    const pageId = current.id;
    switch (record.operation) {
      case "create_page": {
        if (current.in_trash) {
          return {
            result: { inTrash: true },
            note: { kind: "already_in_trash" },
            partial: false,
            commentError: null,
            lastEditedTime: current.last_edited_time,
          };
        }
        // Comment first: a trashed page may not accept comments. It is taken back if Notion refuses
        // the trashing, and kept when the page may be in the trash after all.
        const { commentId, commentError } = await postComment(api, pageId, comment);
        let trashed: NotionPage;
        try {
          trashed = await api.updatePage({ pageId: record.result.pageId, inTrash: true });
        } catch (error) {
          if (commentId && !writeMayHaveApplied(error)) await this.retractOrReport(api, pageId, commentId);
          throw error;
        }
        return { result: { inTrash: true }, note: null, partial: false, commentError, lastEditedTime: trashed.last_edited_time };
      }
      case "append_content":
      case "edit_content": {
        if (restore === null) {
          const { commentError } = await postComment(api, pageId, comment);
          return {
            result: { restored: false },
            note: { kind: "nothing_to_restore" },
            partial: false,
            commentError,
            lastEditedTime: await this.lastEdited(api, pageId),
          };
        }
        // Checked again right before writing: an edit made since the check in revert() would be put back
        // over with the rest of the page, unlike with an edit that changes only part of it.
        const latest = await api.retrievePageMarkdown(pageId).catch((error: unknown) => {
          throw new RevertFailed({ kind: "error", message: errorMessage(error) });
        });
        if (latest.truncated || sha256(latest.markdown) !== record.snapshot.afterSha256) {
          throw new RevertFailed({ kind: "changed_meanwhile" });
        }
        let restored: PageMarkdown;
        try {
          restored = await api.updatePageMarkdown(pageId, { type: "replace_content", replace_content: { new_str: restore } });
        } catch (error) {
          // E.g. the change created a child page, which Notion will not delete without being told to.
          if (error instanceof NotionRequestError && error.status === 400) {
            throw new RevertFailed({ kind: "refused", notionMessage: error.message });
          }
          throw error;
        }
        const { commentError } = await postComment(api, pageId, comment);
        const contentSha256 = restored.truncated ? null : sha256(restored.markdown);
        const note: RevertNote | null =
          contentSha256 !== null && contentSha256 !== record.snapshot.beforeSha256 ? { kind: "content_differs" } : null;
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
        const skipped: PropertySkip[] = [];
        for (const entry of record.snapshot.properties) {
          const writable = toWritablePropertyValue(entry.value);
          if (writable.ok) {
            properties[entry.id] = writable.value;
            restored.push(entry.name);
          } else {
            skipped.push({ name: entry.name, refusal: writable.refusal });
          }
        }
        if (restored.length === 0) throw new RevertFailed({ kind: "nothing_restorable", skipped });
        const updated = await api.updatePage({ pageId, properties });
        const { commentError } = await postComment(api, pageId, comment);
        const partial = skipped.length > 0;
        const note: RevertNote | null = partial ? { kind: "properties_partial", restored, skipped } : null;
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
            note: { kind: "already_restored" },
            partial: false,
            commentError: null,
            lastEditedTime: current.last_edited_time,
          };
        }
        const restoredPage = await api.updatePage({ pageId, inTrash: false });
        const { commentError } = await postComment(api, pageId, comment);
        return { result: { inTrash: false }, note: null, partial: false, commentError, lastEditedTime: restoredPage.last_edited_time };
      }
      default:
        throw new Error(`Unknown revert operation: ${record satisfies never}`);
    }
  }

  /** A failed revert keeps no comment claiming it happened; one that cannot be removed is logged. */
  private async retractOrReport(api: NotionApi, pageId: string, commentId: string): Promise<void> {
    const error = await retractComment(api, commentId);
    if (error) this.reportError({ event: "notion_comment_retract_failed", pageId, commentId, error });
  }

  private async lastEdited(api: NotionApi, pageId: string): Promise<string | null> {
    // The revert is done: a failed read-back only loses its edit time (a later revert then sees a conflict).
    const page = await api.retrievePage(pageId).catch((error: unknown) => {
      this.reportError({ event: "notion_readback_failed", pageId, error: errorMessage(error) });
      return null;
    });
    return page?.last_edited_time ?? null;
  }
}

/** At the pace rows go stale: a dead write is marked within twice STALE_PENDING_MS, which is soon enough. */
const SWEEP_INTERVAL_MS = STALE_PENDING_MS;

export interface InterruptedWriteSweepOptions {
  audit: Pick<NotionAuditService, "markInterruptedWrites">;
  log: EventSink;
  logError: ErrorSink;
  intervalMs?: number;
}

/**
 * Marks writes a dead process left pending as interrupted, now and every 10 minutes, so a
 * pending revert claim cannot block its row until the next restart. Rows written just before
 * a crash, or by the old process during a rolling deploy, are not stale at startup, hence the
 * repeats. Returns a stop function.
 */
export function startInterruptedWriteSweep({
  audit,
  log,
  logError,
  intervalMs = SWEEP_INTERVAL_MS,
}: InterruptedWriteSweepOptions): () => void {
  return runPeriodically(() => {
    audit.markInterruptedWrites().then(
      (count) => {
        if (count > 0) log({ event: "audit_pending_interrupted", count });
      },
      (error: unknown) => logError({ event: "audit_sweep_failed", error: errorMessage(error) }),
    );
  }, intervalMs);
}
