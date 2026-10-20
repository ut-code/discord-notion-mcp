import type { PropertyWriteRefusal } from "../content/properties";
import type { PropertySkip, RevertNote, WriteWarning } from "./audit-records";
import type { RevertBlocker, RevertConflict, RevertFailure, RevertReason, RevertResult } from "./revert-reasons";

/* English wording of write and revert outcomes for MCP tools; the dashboard words them in Japanese (dashboard/outcome-text.ts). */

export function propertyWriteRefusalText(refusal: PropertyWriteRefusal): string {
  switch (refusal.kind) {
    case "hosted_files":
      return `contains Notion-hosted file(s) (${refusal.files.join(", ")}) that cannot be re-set through the API`;
    case "unsupported_type":
      return `property type "${refusal.type}" is read-only or not supported for writes`;
    default:
      throw new Error(`Unknown property write refusal: ${refusal satisfies never}`);
  }
}

export function writeWarningText(warning: WriteWarning): string {
  switch (warning.kind) {
    case "content_failed":
      return `Page created, but adding its content failed: ${warning.error}`;
    case "revert_blocked":
      return warning.blocker === "truncated_after_write"
        ? `The change was applied, but automatic revert may not be possible: ${revertBlockerText(warning.blocker)}.`
        : `The change was applied, but automatic revert is not possible: ${revertBlockerText(warning.blocker)}.`;
    default:
      throw new Error(`Unknown write warning: ${warning satisfies never}`);
  }
}

function revertBlockerText(blocker: RevertBlocker): string {
  switch (blocker) {
    case "truncated_after_write":
      return "Notion returned truncated content after the write, so the change could not be captured";
    case "concurrent_edit":
      return "someone else edited the page at the same moment, and undoing the change would undo theirs too";
    case "unlocated_edit":
      return "where the change landed in the page could not be determined, so undoing it might also undo someone else's edit made at the same moment";
    case "child_object_created":
      return "the change created a child page or database, which a revert cannot remove; move it to the trash by hand";
    default:
      throw new Error(`Unknown revert blocker: ${blocker satisfies never}`);
  }
}

function skippedText(skipped: readonly PropertySkip[]): string {
  return skipped.map((skip) => `"${skip.name}" (${propertyWriteRefusalText(skip.refusal)})`).join("; ");
}

function revertNoteText(note: RevertNote): string {
  switch (note.kind) {
    case "already_in_trash":
      return "The page was already in the trash.";
    case "nothing_to_restore":
      return "The change did not alter the page content; nothing to restore.";
    case "content_differs":
      return "The restored content is not identical to the content before the change (later edits or Notion formatting).";
    case "already_restored":
      return "The page was already restored from the trash.";
    case "properties_partial":
      return `Restored ${note.restored.join(", ")}; could not restore ${skippedText(note.skipped)}.`;
    default:
      throw new Error(`Unknown revert note: ${note satisfies never}`);
  }
}

export function revertConflictText(id: number, conflict: RevertConflict): string {
  switch (conflict.kind) {
    case "no_recorded_time":
      return `Audit #${id} has no recorded last_edited_time, so later edits cannot be ruled out.`;
    case "edited_after":
      return `The page was edited after audit #${id} (last_edited_time ${conflict.recorded} at the time of the write, now ${conflict.now}); reverting may undo or conflict with those later changes.`;
    case "content_changed":
      return `The page content changed after audit #${id}; putting the earlier content back would undo those later changes.`;
    case "properties_changed":
      return `${conflict.names.join(", ")} changed after audit #${id}; reverting would overwrite those later changes.`;
    default:
      throw new Error(`Unknown revert conflict: ${conflict satisfies never}`);
  }
}

export function revertFailureText(id: number, failure: RevertFailure): string {
  switch (failure.kind) {
    case "changed_meanwhile":
      return `The page changed while audit #${id} was being reverted, so nothing was changed; check the page and revert again.`;
    case "refused":
      return `Notion refused to put back the content from before audit #${id}, so it was not reverted; restore it by hand. (Notion: ${failure.notionMessage})`;
    case "nothing_restorable":
      return `No property could be restored: ${skippedText(failure.skipped)}`;
    case "superseded":
      return `The revert ran, but meanwhile it had been marked interrupted and another revert of audit #${id} started; check the page.`;
    case "unconfirmed":
      return `Notion did not confirm the revert (${failure.detail}), so it may or may not have been applied. Read the page with notion_get_page before reverting audit #${id} again.`;
    case "error":
      return failure.message;
    default:
      throw new Error(`Unknown revert failure: ${failure satisfies never}`);
  }
}

export function revertReasonText(id: number, reason: RevertReason): string {
  switch (reason.kind) {
    case "not_found":
      return `Audit #${id} not found.`;
    case "in_progress":
      return `A revert of audit #${id} is already in progress.`;
    case "is_revert":
      return "Reverting a revert is not supported.";
    case "not_ok":
      switch (reason.status) {
        case "failed":
          return `Audit #${id} is a failed write; there is nothing to revert.`;
        case "pending":
          return `Audit #${id} is still pending; there is nothing to revert yet.`;
        case "interrupted":
          return `Audit #${id} was interrupted, so whether Notion applied it is unknown; check the page and fix it by hand.`;
        default:
          throw new Error(`Unknown audit status: ${reason.status satisfies never}`);
      }
    case "already_reverted":
      return `Audit #${id} was already reverted at ${reason.revertedAt.toISOString()} (revert audit #${reason.revertAuditId ?? "?"}).`;
    case "notion_disabled":
      return "Notion is not configured (NOTION_TOKEN is not set).";
    case "no_target":
      return `Audit #${id} has no target page.`;
    case "unrecognized_snapshot":
      return `Audit #${id} has an unrecognized snapshot format; it cannot be reverted automatically.`;
    case "blocked":
      return `Audit #${id} cannot be reverted automatically: ${revertBlockerText(reason.blocker)}.`;
    case "page_inaccessible":
      return "The page is no longer accessible to the integration.";
    case "too_large":
      return `The page is now too large to revert audit #${id} automatically.`;
    case "conflict":
      return revertConflictText(id, reason.conflict);
    case "failed":
      return `Revert of audit #${id} failed: ${revertFailureText(id, reason.failure)}`;
    default:
      throw new Error(`Unknown revert reason: ${reason satisfies never}`);
  }
}

export function revertSuccessText(id: number, result: Extract<RevertResult, { ok: true }>): string {
  return result.note ? `Reverted audit #${id}: ${revertNoteText(result.note)}` : `Reverted audit #${id}.`;
}
