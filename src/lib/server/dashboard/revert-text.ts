import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { parseStoredJson, WriteWarningSchema, type WriteWarning } from "../notion/changes/audit-records";
import type { PropertyWriteRefusal } from "../notion/content/properties";
import {
  RevertNoteSchema,
  type PropertySkip,
  type RevertBlocker,
  type RevertFailure,
  type RevertNote,
  type RevertReason,
} from "../notion/changes/revert-reasons";
import { formatJst } from "./format";

/* Dashboard wording of write notes and revert outcomes; the MCP tools word the same data in English. */

function blockerText(blocker: string): string {
  switch (blocker) {
    case "no_anchor" satisfies RevertBlocker:
      return m.revert_blocker_no_anchor();
    case "ambiguous_inverse" satisfies RevertBlocker:
      return m.revert_blocker_ambiguous_inverse();
    case "truncated_after_write" satisfies RevertBlocker:
      return m.revert_blocker_truncated_after_write();
    default:
      return blocker;
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
      return warning.blocker === ("truncated_after_write" satisfies RevertBlocker)
        ? m.write_warning_revert_maybe_blocked({ reason: blockerText(warning.blocker) })
        : m.write_warning_revert_blocked({ reason: blockerText(warning.blocker) });
    default:
      throw new Error(`Unknown write warning: ${warning satisfies never}`);
  }
}

/** A note stored as JSON (write warning or revert note); older rows hold English text, shown as is. */
export function storedNoteText(raw: string): string {
  const note = parseStoredJson(RevertNoteSchema, raw);
  if (note) return noteText(note);
  const warning = parseStoredJson(WriteWarningSchema, raw);
  return warning ? writeWarningText(warning) : raw;
}

function failureText(failure: RevertFailure): string {
  switch (failure.kind) {
    case "text_gone":
      return m.revert_failure_text_gone({ notionMessage: failure.notionMessage });
    case "nothing_restorable":
      return m.revert_failure_nothing_restorable({ skipped: skippedText(failure.skipped) });
    case "superseded":
      return m.revert_failure_superseded();
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
      return reason.status === "failed" ? m.revert_reason_not_ok_failed() : m.revert_reason_not_ok_pending();
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

function revertHeadText({ forced, partial }: { forced: boolean; partial: boolean }): string {
  if (forced) return partial ? m.revert_success_forced_partial() : m.revert_success_forced();
  return partial ? m.revert_success_partial() : m.revert_success();
}

export function revertSuccessText(result: { forced: boolean; partial: boolean; note: RevertNote | null }): string {
  const head = revertHeadText(result);
  return result.note ? `${head}${noteText(result.note)}` : head;
}
