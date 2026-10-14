import { z } from "zod";
import type { RevertPlanBlocker } from "../content/content-diff";
import { propertyWriteRefusalText, type PropertyWriteRefusal } from "../content/properties";

/*
 * Revert outcomes as data. The service returns these; the MCP tools word them in
 * English (below) and the dashboard in Japanese (dashboard/revert-text.ts).
 */

/** Stored in ContentSnapshot.revertBlocker; rows written before these codes hold English text. */
export type RevertBlocker = RevertPlanBlocker | "truncated_after_write";

/** Why the page may have changed since the write; reverting anyway needs `force`. */
export type RevertConflict =
  { kind: "no_recorded_time" } | { kind: "edited_after"; recorded: string; now: string } | { kind: "content_changed" };

const PropertyWriteRefusalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hosted_files"), files: z.array(z.string()) }),
  z.object({ kind: z.literal("unsupported_type"), type: z.string() }),
]) satisfies z.ZodType<PropertyWriteRefusal>;

const PropertySkipSchema = z.object({ name: z.string(), refusal: PropertyWriteRefusalSchema });
export type PropertySkip = z.infer<typeof PropertySkipSchema>;

/** What a successful revert wants the reader to know; stored as JSON in revert_note. */
export const RevertNoteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("already_in_trash") }),
  z.object({ kind: z.literal("nothing_to_restore") }),
  z.object({ kind: z.literal("content_differs") }),
  z.object({ kind: z.literal("already_restored") }),
  z.object({ kind: z.literal("properties_partial"), restored: z.array(z.string()), skipped: z.array(PropertySkipSchema) }),
]);
export type RevertNote = z.infer<typeof RevertNoteSchema>;

/** A revert that was tried and failed; the attempt is recorded as a failed revert row. */
export type RevertFailure =
  | { kind: "text_gone"; notionMessage: string }
  | { kind: "nothing_restorable"; skipped: PropertySkip[] }
  /** Notion was reverted, but the log had given this revert up as interrupted and another one started. */
  | { kind: "superseded" }
  | { kind: "error"; message: string };

export type RevertReason =
  | { kind: "not_found" }
  | { kind: "in_progress" }
  | { kind: "is_revert" }
  | { kind: "not_ok"; status: "failed" | "pending" }
  | { kind: "already_reverted"; revertedAt: Date; revertAuditId: number | null }
  | { kind: "notion_disabled" }
  | { kind: "no_target" }
  | { kind: "unrecognized_snapshot" }
  /** A RevertBlocker code, or English text on older rows. */
  | { kind: "blocked"; blocker: string }
  | { kind: "page_inaccessible" }
  | { kind: "too_large" }
  | { kind: "conflict"; conflict: RevertConflict }
  | { kind: "failed"; failure: RevertFailure; revertAuditId: number };

export type RevertResult =
  { ok: true; revertAuditId: number; forced: boolean; partial: boolean; note: RevertNote | null } | { ok: false; reason: RevertReason };

export function revertBlockerText(blocker: string): string {
  switch (blocker) {
    case "no_anchor" satisfies RevertBlocker:
      return "the page has no text left to anchor a revert on";
    case "ambiguous_inverse" satisfies RevertBlocker:
      return "no unambiguous inverse edit could be computed";
    case "truncated_after_write" satisfies RevertBlocker:
      return "Notion returned truncated content after the write, so the change could not be captured";
    default:
      return blocker;
  }
}

function skippedText(skipped: readonly PropertySkip[]): string {
  return skipped.map((skip) => `"${skip.name}" (${propertyWriteRefusalText(skip.refusal)})`).join("; ");
}

export function revertNoteText(note: RevertNote): string {
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
      return `The page content changed after audit #${id}; reverting may fail or undo those later changes.`;
    default:
      throw new Error(`Unknown revert conflict: ${conflict satisfies never}`);
  }
}

export function revertFailureText(id: number, failure: RevertFailure): string {
  switch (failure.kind) {
    case "text_gone":
      return `The page no longer contains the text written by audit #${id} in its original form, so it cannot be reverted automatically; restore it by hand. (Notion: ${failure.notionMessage})`;
    case "nothing_restorable":
      return `No property could be restored: ${skippedText(failure.skipped)}`;
    case "superseded":
      return `The revert ran, but meanwhile it had been marked interrupted and another revert of audit #${id} started; check the page.`;
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
      return `Audit #${id} is ${reason.status === "failed" ? "a failed write" : "still pending"}; there is nothing to revert.`;
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
  const forced = result.forced ? " (forced despite later edits)" : "";
  return result.note ? `Reverted audit #${id}${forced}: ${revertNoteText(result.note)}` : `Reverted audit #${id}${forced}.`;
}
