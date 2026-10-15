import type { NotionAuditStatus } from "../../db/schema";
import type { RevertPlanBlocker } from "../content/content-diff";
import type { PropertySkip, RevertNote } from "./audit-records";

/*
 * Revert outcomes as data. The service returns these; the MCP tools word them in English
 * (outcome-text.ts) and the dashboard in Japanese (dashboard/outcome-text.ts).
 */

/** Stored in ContentSnapshot.revertBlocker; rows written before these codes hold English text. */
export type RevertBlocker = RevertPlanBlocker | "truncated_after_write";

/** Why the page may have changed since the write; reverting anyway needs `force`. */
export type RevertConflict =
  { kind: "no_recorded_time" } | { kind: "edited_after"; recorded: string; now: string } | { kind: "content_changed" };

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
  | { kind: "not_ok"; status: Exclude<NotionAuditStatus, "ok"> }
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
