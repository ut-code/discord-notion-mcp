import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { AuditNoteSchema, type PropertySkip, type RevertNote, type WriteWarning } from "../notion/changes/audit-records";
import type { RevertBlocker, RevertFailure, RevertReason } from "../notion/changes/revert-reasons";
import type { PropertyWriteRefusal } from "../notion/content/properties";
import { formatJst } from "./format";

/* Dashboard wording of write notes and revert outcomes; the MCP tools word the same data in English. */

function blockerText(blocker: RevertBlocker): string {
  switch (blocker) {
    case "truncated_after_write":
      return m.revert_blocker_truncated_after_write();
    case "concurrent_edit":
      return m.revert_blocker_concurrent_edit();
    case "unlocated_edit":
      return m.revert_blocker_unlocated_edit();
    case "child_object_created":
      return m.revert_blocker_child_object_created();
    default:
      throw new Error(`Unknown revert blocker: ${blocker satisfies never}`);
  }
}

function joinList(items: readonly string[]): string {
  return new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(items);
}

function propertyRefusalText(refusal: PropertyWriteRefusal): string {
  switch (refusal.kind) {
    case "hosted_files":
      return m.revert_refusal_hosted_files({ files: joinList(refusal.files) });
    case "unsupported_type":
      return m.revert_refusal_unsupported_type({ type: refusal.type });
    default:
      throw new Error(`Unknown property write refusal: ${refusal satisfies never}`);
  }
}

function skippedText(skipped: readonly PropertySkip[]): string {
  return joinList(skipped.map((skip) => m.revert_skipped_property({ name: skip.name, reason: propertyRefusalText(skip.refusal) })));
}

function noteText(note: RevertNote): string {
  switch (note.kind) {
    case "already_in_trash":
      return m.revert_note_already_in_trash();
    case "nothing_to_restore":
      return m.revert_note_nothing_to_restore();
    case "content_differs":
      return m.revert_note_content_differs();
    case "already_restored":
      return m.revert_note_already_restored();
    case "properties_partial":
      return m.revert_note_properties_partial({
        restored: joinList(note.restored.map((name) => m.revert_property_name({ name }))),
        skipped: skippedText(note.skipped),
      });
    default:
      throw new Error(`Unknown revert note: ${note satisfies never}`);
  }
}

function writeWarningText(warning: WriteWarning): string {
  switch (warning.kind) {
    case "content_failed":
      return m.write_warning_content_failed({ error: warning.error });
    case "revert_blocked":
      return warning.blocker === "truncated_after_write"
        ? m.write_warning_revert_maybe_blocked({ reason: blockerText(warning.blocker) })
        : m.write_warning_revert_blocked({ reason: blockerText(warning.blocker) });
    default:
      throw new Error(`Unknown write warning: ${warning satisfies never}`);
  }
}

/** The `note` or `revert_note` of a row; null when there is none. */
export function auditNoteText(stored: unknown): string | null {
  if (stored === null || stored === undefined) return null;
  const parsed = AuditNoteSchema.safeParse(stored);
  // A note of a kind this version does not know (written by a newer one, read after a rollback).
  if (!parsed.success) return m.audit_note_unreadable();
  const note = parsed.data;
  switch (note.kind) {
    case "content_failed":
    case "revert_blocked":
      return writeWarningText(note);
    default:
      return noteText(note);
  }
}

function failureText(failure: RevertFailure): string {
  switch (failure.kind) {
    case "changed_meanwhile":
      return m.revert_failure_changed_meanwhile();
    case "refused":
      return m.revert_failure_refused({ notionMessage: failure.notionMessage });
    case "nothing_restorable":
      return m.revert_failure_nothing_restorable({ skipped: skippedText(failure.skipped) });
    case "superseded":
      return m.revert_failure_superseded();
    case "unconfirmed":
      return m.revert_failure_unconfirmed({ detail: failure.detail });
    case "error":
      return failure.message;
    default:
      throw new Error(`Unknown revert failure: ${failure satisfies never}`);
  }
}

export function revertReasonText(reason: RevertReason): string {
  switch (reason.kind) {
    case "not_found":
      return m.audit_not_found();
    case "in_progress":
      return m.revert_reason_in_progress();
    case "is_revert":
      return m.revert_reason_is_revert();
    case "not_ok":
      switch (reason.status) {
        case "failed":
          return m.revert_reason_not_ok_failed();
        case "pending":
          return m.revert_reason_not_ok_pending();
        case "interrupted":
          return m.revert_reason_not_ok_interrupted();
        default:
          throw new Error(`Unknown audit status: ${reason.status satisfies never}`);
      }
    case "already_reverted":
      return m.revert_reason_already_reverted({ time: formatJst(reason.revertedAt) });
    case "notion_disabled":
      return m.revert_reason_notion_disabled();
    case "no_target":
      return m.revert_reason_no_target();
    case "unrecognized_snapshot":
      return m.revert_reason_unrecognized_snapshot();
    case "blocked":
      return m.revert_reason_blocked({ reason: blockerText(reason.blocker) });
    case "page_inaccessible":
      return m.revert_reason_page_inaccessible();
    case "too_large":
      return m.revert_reason_too_large();
    case "conflict":
      return m.revert_reason_conflict();
    case "failed":
      return m.revert_reason_failed({ reason: failureText(reason.failure) });
    default:
      throw new Error(`Unknown revert reason: ${reason satisfies never}`);
  }
}

export function revertSuccessText(result: { partial: boolean; note: RevertNote | null }): string {
  const head = result.partial ? m.revert_success_partial() : m.revert_success();
  return result.note ? `${head}${noteText(result.note)}` : head;
}
