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

/* Japanese wording of write notes and revert outcomes; the MCP tools word the same data in English. */

function blockerText(blocker: string): string {
  switch (blocker) {
    case "no_anchor" satisfies RevertBlocker:
      return "ページに文字が残っておらず、元に戻す位置を決められません";
    case "ambiguous_inverse" satisfies RevertBlocker:
      return "元に戻す編集を一つに決められません";
    case "truncated_after_write" satisfies RevertBlocker:
      return "書き込み後のページが大きすぎて、変更内容を記録できませんでした";
    default:
      return blocker;
  }
}

function propertyRefusalText(refusal: PropertyWriteRefusal): string {
  switch (refusal.kind) {
    case "hosted_files":
      return `Notion にアップロードされたファイル（${refusal.files.join("、")}）は API で設定し直せません`;
    case "unsupported_type":
      return `「${refusal.type}」型は読み取り専用か、書き込みに対応していません`;
    default:
      throw new Error(`Unknown property write refusal: ${refusal satisfies never}`);
  }
}

function skippedText(skipped: readonly PropertySkip[]): string {
  return skipped.map((skip) => `「${skip.name}」（${propertyRefusalText(skip.refusal)}）`).join("、");
}

function noteText(note: RevertNote): string {
  switch (note.kind) {
    case "already_in_trash":
      return "ページはすでにゴミ箱にありました。";
    case "nothing_to_restore":
      return "本文は変わっていなかったため、戻すものはありませんでした。";
    case "content_differs":
      return "戻した本文が変更前と完全には一致しません（後からの編集か Notion の整形によるものです）。";
    case "already_restored":
      return "ページはすでにゴミ箱から戻されていました。";
    case "properties_partial":
      return `${note.restored.map((name) => `「${name}」`).join("、")}を戻しました。${skippedText(note.skipped)}は戻せませんでした。`;
    default:
      throw new Error(`Unknown revert note: ${note satisfies never}`);
  }
}

function writeWarningText(warning: WriteWarning): string {
  switch (warning.kind) {
    case "content_failed":
      return `ページは作成しましたが、本文の追加に失敗しました: ${warning.error}`;
    case "revert_blocked":
      return warning.blocker === ("truncated_after_write" satisfies RevertBlocker)
        ? `書き込みは反映しましたが、自動では取り消せない可能性があります: ${blockerText(warning.blocker)}。`
        : `書き込みは反映しましたが、自動では取り消せません: ${blockerText(warning.blocker)}。`;
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
      return `ページの本文が書き込み時から変わっているため、自動では取り消せません。手作業で戻してください。（Notion: ${failure.notionMessage}）`;
    case "nothing_restorable":
      return `戻せるプロパティがありません: ${skippedText(failure.skipped)}`;
    case "error":
      return failure.message;
    default:
      throw new Error(`Unknown revert failure: ${failure satisfies never}`);
  }
}

export function revertReasonText(reason: RevertReason): string {
  switch (reason.kind) {
    case "not_found":
      return "指定された履歴はありません。";
    case "in_progress":
      return "この変更はいま取り消し処理中です。";
    case "is_revert":
      return "取り消しの記録はさらに取り消せません。";
    case "not_ok":
      return reason.status === "failed" ? "失敗した書き込みなので、取り消すものがありません。" : "まだ処理中の書き込みです。";
    case "already_reverted":
      return `${formatJst(reason.revertedAt)} に取り消し済みです。`;
    case "notion_disabled":
      return "NOTION_TOKEN が未設定のため取り消せません。";
    case "no_target":
      return "対象ページが記録されていないため取り消せません。";
    case "unrecognized_snapshot":
      return "記録の形式を読み取れないため、自動では取り消せません。";
    case "blocked":
      return `自動では取り消せない変更です: ${blockerText(reason.blocker)}。`;
    case "page_inaccessible":
      return "ページにアクセスできません（削除されたか、連携が外れています）。";
    case "too_large":
      return "ページが大きくなりすぎたため、自動では取り消せません。";
    case "conflict":
      return "この変更の後にページが編集されています。";
    case "failed":
      return `取り消せませんでした: ${failureText(reason.failure)}`;
    default:
      throw new Error(`Unknown revert reason: ${reason satisfies never}`);
  }
}

export function revertSuccessText(result: { forced: boolean; partial: boolean; note: RevertNote | null }): string {
  const head = `${result.forced ? "後からの編集があるまま" : ""}${result.partial ? "一部のみ取り消しました。" : "取り消しました。"}`;
  return result.note ? `${head}${noteText(result.note)}` : head;
}
