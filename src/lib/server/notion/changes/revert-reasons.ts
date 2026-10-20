import type { NotionAuditStatus } from "../../db/schema";
import type { WriteBlocker } from "../content/content-diff";
import type { PropertySkip, RevertNote } from "./audit-records";

/*
 * Revert outcomes as data. The service returns these; the MCP tools word them in English
 * (outcome-text.ts) and the dashboard in Japanese (dashboard/outcome-text.ts).
 */

/** Why a content write cannot be reverted automatically; stored in ContentSnapshot.revertBlocker. */
export type RevertBlocker = WriteBlocker | "truncated_after_write" | "child_object_created";

/** Why the page may have changed since the write, so it is not reverted automatically. */
export type RevertConflict =
  | { kind: "no_recorded_time" }
  | { kind: "edited_after"; recorded: string; now: string }
  | { kind: "content_changed" }
  /** Properties our write set that now hold other values. */
  | { kind: "properties_changed"; names: string[] };

/** A revert that was tried and failed; the attempt is recorded as a failed revert row. */
export type RevertFailure =
  /** The page changed between the conflict check and the write, so nothing was written. */
  | { kind: "changed_meanwhile" }
  /** Notion refused to put the content back (e.g. it would delete a child page the change created). */
  | { kind: "refused"; notionMessage: string }
  | { kind: "nothing_restorable"; skipped: PropertySkip[] }
  /** Notion was reverted, but the log had given this revert up as interrupted and another one started. */
  | { kind: "superseded" }
  /** Notion did not confirm the revert (5xx, timeout): it may have been applied; `detail` says why. */
  | { kind: "unconfirmed"; detail: string }
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
  | { kind: "blocked"; blocker: RevertBlocker }
  | { kind: "page_inaccessible" }
  | { kind: "too_large" }
  /** A created page that now holds child pages or databases, whose own edits do not show on it. */
  | { kind: "has_child_objects" }
  | { kind: "conflict"; conflict: RevertConflict }
  | { kind: "failed"; failure: RevertFailure; revertAuditId: number };

export type RevertResult =
  { ok: true; revertAuditId: number; partial: boolean; note: RevertNote | null } | { ok: false; reason: RevertReason };
