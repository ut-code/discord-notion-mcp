import { dashboardAuditPath, DASHBOARD_PATH } from "../../paths";
import { NOTION_AUDIT_OPERATIONS, type NotionAuditOperation, type NotionAuditRow } from "../db/schema";
import { errorMessage } from "../lib/errors";
import { isSnowflake } from "../lib/snowflake";
import {
  AppendContentRequestSchema,
  ContentSnapshotSchema,
  ContentUpdateSchema,
  EditContentRequestSchema,
  UpdatePropertiesSnapshotSchema,
} from "../notion/changes/audit-records";
import type { ContentHunk } from "../notion/content/content-diff";
import { renderPropertyValue } from "../notion/content/properties";
import { ADMIN_ONLY, type Viewer } from "./access";
import type { BadgeView } from "./badges";
import type { DashboardDeps } from "./deps";
import {
  AUDIT_OPERATION_LABELS,
  AUDIT_STATUS_FILTERS,
  formatJst,
  formatShortJst,
  isAuditStatusFilter,
  renderRequestedPropertyValue,
  type AuditStatusFilter,
} from "./format";
import { formString, pageParam, type ActionResult, type Option } from "./shared";

const AUDIT_PAGE_SIZE = 50;

/** 404 page of an unknown write-history entry. */
export const AUDIT_NOT_FOUND = { title: "見つかりません", message: "指定された履歴はありません。" };

export interface AuditFilters {
  user?: string;
  operation?: NotionAuditOperation;
  status?: AuditStatusFilter;
}

function isAuditOperation(value: string | null): value is NotionAuditOperation {
  return value !== null && (NOTION_AUDIT_OPERATIONS as readonly string[]).includes(value);
}

export function auditListHref(filters: AuditFilters, page = 1): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${DASHBOARD_PATH}/audit?${query}` : `${DASHBOARD_PATH}/audit`;
}

/** Title recorded with the write; older rows fall back to the requested title or a generic label. */
function auditTitle(row: NotionAuditRow): string {
  if (row.targetTitle) return row.targetTitle;
  const requested = row.operation === "create_page" ? row.request.title : undefined;
  return typeof requested === "string" && requested ? requested : "Notion ページ";
}

/** Full status of the detail page: 成功 + 取り消し済み for a reverted write. */
function statusBadges(row: NotionAuditRow): BadgeView[] {
  if (row.status === "failed") return [{ label: "失敗", tone: "destructive" }];
  if (row.status === "pending") return [{ label: "処理中", tone: "secondary" }];
  if (!row.revertedAt) return [{ label: "成功", tone: "success" }];
  return [
    { label: "成功", tone: "success" },
    { label: "取り消し済み", tone: "secondary" },
  ];
}

/** Lists flag only exceptions; a plain successful write has no badge. */
function exceptionBadge(row: NotionAuditRow): BadgeView | null {
  if (row.status === "failed") return { label: "失敗", tone: "destructive" };
  if (row.status === "pending") return { label: "処理中", tone: "secondary" };
  if (row.revertedAt) return { label: "取り消し済み", tone: "secondary" };
  return null;
}

export interface AuditRowView {
  id: number;
  href: string;
  createdAt: string;
  user: { id: string; name: string; avatarUrl: string | null };
  operation: string;
  /** Source row of a revert. */
  revertOf: number | null;
  title: string;
  targetUrl: string | null;
  badge: BadgeView | null;
  /** One-line summary under the title in compact lists: "操作 · ユーザー · 日時". */
  meta: string;
}

export function auditRowView(row: NotionAuditRow, avatars: ReadonlyMap<string, string> = new Map()): AuditRowView {
  const createdAt = formatShortJst(row.createdAt);
  const action =
    row.operation === "revert" && row.revertOfAuditId !== null
      ? `#${row.revertOfAuditId} を取り消し`
      : AUDIT_OPERATION_LABELS[row.operation];
  return {
    id: row.id,
    href: dashboardAuditPath(row.id),
    createdAt,
    user: { id: row.discordUserId, name: row.discordDisplayName, avatarUrl: avatars.get(row.discordUserId) ?? null },
    operation: AUDIT_OPERATION_LABELS[row.operation],
    revertOf: row.revertOfAuditId,
    title: auditTitle(row),
    targetUrl: row.targetUrl,
    badge: exceptionBadge(row),
    meta: [action, row.discordDisplayName, createdAt].join(" · "),
  };
}

export interface AuditListData {
  rows: AuditRowView[];
  total: number;
  /** "N 件中 a–b 件"; null when empty. */
  range: string | null;
  prevHref: string | null;
  nextHref: string | null;
  filters: { user: string; operation: string; status: string };
  userOptions: Option[];
  operationOptions: Option[];
  statusOptions: Option[];
  /** Shown when the user filter is not a Discord id. */
  error: string | null;
}

export async function auditList(deps: DashboardDeps, params: URLSearchParams): Promise<AuditListData> {
  const filters: AuditFilters = {};
  let error: string | null = null;
  const user = params.get("user")?.trim();
  if (user) {
    if (isSnowflake(user)) filters.user = user;
    else error = "ユーザー ID は Discord の数値 ID で指定してください。";
  }
  const operation = params.get("operation");
  if (isAuditOperation(operation)) filters.operation = operation;
  const status = params.get("status") ?? undefined;
  if (isAuditStatusFilter(status)) filters.status = status;

  const page = pageParam(params.get("page"));
  const [{ rows, total }, actors] = await Promise.all([
    deps.audit.listAudit({
      limit: AUDIT_PAGE_SIZE,
      offset: (page - 1) * AUDIT_PAGE_SIZE,
      discordUserId: filters.user,
      operation: filters.operation,
      status: filters.status === "ok" || filters.status === "failed" ? filters.status : undefined,
      reverted: filters.status === "reverted" ? true : undefined,
    }),
    deps.audit.listActors(),
  ]);
  const avatars = await deps.subjects.memberAvatars(rows.map((row) => row.discordUserId));
  const first = (page - 1) * AUDIT_PAGE_SIZE + 1;
  const last = first + rows.length - 1;
  // Keep a filtered user selectable even when it has no rows any more.
  const userOptions = actors.map((actor) => ({ value: actor.discordUserId, label: actor.displayName }));
  if (filters.user && !userOptions.some((option) => option.value === filters.user)) {
    userOptions.push({ value: filters.user, label: filters.user });
  }
  return {
    rows: rows.map((row) => auditRowView(row, avatars)),
    total,
    range: total > 0 ? `${total} 件中 ${first}–${last} 件` : null,
    prevHref: page > 1 ? auditListHref(filters, page - 1) : null,
    nextHref: last < total ? auditListHref(filters, page + 1) : null,
    filters: { user: filters.user ?? "", operation: filters.operation ?? "", status: filters.status ?? "" },
    userOptions,
    operationOptions: NOTION_AUDIT_OPERATIONS.map((value) => ({ value, label: AUDIT_OPERATION_LABELS[value] })),
    statusOptions: (Object.keys(AUDIT_STATUS_FILTERS) as AuditStatusFilter[]).map((value) => ({
      value,
      label: AUDIT_STATUS_FILTERS[value],
    })),
    error,
  };
}

const DONE: Record<NotionAuditOperation, (title: string, row: NotionAuditRow) => string> = {
  create_page: (t) => `「${t}」を作成しました`,
  append_content: (t) => `「${t}」に内容を追記しました`,
  edit_content: (t) => `「${t}」の本文を編集しました`,
  update_properties: (t) => `「${t}」のプロパティを更新しました`,
  archive_page: (t) => `「${t}」をアーカイブしました`,
  revert: (t, row) => `「${t}」への #${row.revertOfAuditId ?? "?"} の変更を取り消しました`,
};

const FAILED: Record<NotionAuditOperation, (title: string, row: NotionAuditRow) => string> = {
  create_page: (t) => `「${t}」の作成に失敗しました`,
  append_content: (t) => `「${t}」への追記に失敗しました`,
  edit_content: (t) => `「${t}」の本文の編集に失敗しました`,
  update_properties: (t) => `「${t}」のプロパティの更新に失敗しました`,
  archive_page: (t) => `「${t}」のアーカイブに失敗しました`,
  revert: (t, row) => `「${t}」への #${row.revertOfAuditId ?? "?"} の変更の取り消しに失敗しました`,
};

function summarySentence(row: NotionAuditRow): string {
  const title = auditTitle(row);
  const action =
    row.status === "ok"
      ? DONE[row.operation](title, row)
      : row.status === "failed"
        ? FAILED[row.operation](title, row)
        : `「${title}」の${AUDIT_OPERATION_LABELS[row.operation]}を処理しています`;
  return `${row.discordDisplayName} が ${formatShortJst(row.createdAt)} に${action}。`;
}

/** Stored hunks; failed writes have none, so the requested change is shown instead. */
function contentHunks(row: NotionAuditRow): ContentHunk[] {
  const snapshot = ContentSnapshotSchema.safeParse(row.snapshot);
  if (snapshot.success) return snapshot.data.hunks;
  if (row.operation === "append_content") {
    const content = AppendContentRequestSchema.safeParse(row.request).data?.content;
    return content ? [{ before: "", after: content }] : [];
  }
  const edits = EditContentRequestSchema.safeParse(row.request).data?.edits ?? [];
  return edits.flatMap((edit) => {
    const update = ContentUpdateSchema.safeParse(edit);
    return update.success ? [{ before: update.data.old_str, after: update.data.new_str }] : [];
  });
}

const linesOf = (text: string) => (text === "" ? [] : text.split("\n"));

export interface DiffLine {
  kind: "del" | "add" | "gap";
  text: string;
}

/** Hunks as −/+ lines with a ⋯ separator between hunks. */
export function diffLines(hunks: readonly ContentHunk[]): DiffLine[] {
  return hunks.flatMap((hunk, index) => [
    ...(index > 0 ? [{ kind: "gap" as const, text: "⋯" }] : []),
    ...linesOf(hunk.before).map((line) => ({ kind: "del" as const, text: `− ${line}` })),
    ...linesOf(hunk.after).map((line) => ({ kind: "add" as const, text: `+ ${line}` })),
  ]);
}

export type ChangeView =
  | { kind: "diff"; meta: string | null; lines: DiffLine[] }
  | { kind: "properties"; meta: string | null; entries: Array<{ name: string; before: string; after: string }> }
  | { kind: "created"; title: string; targetUrl: string | null }
  | { kind: "archived" }
  | { kind: "revert"; of: { id: number; href: string } | null };

function changeView(row: NotionAuditRow): ChangeView {
  switch (row.operation) {
    case "append_content":
    case "edit_content": {
      const hunks = contentHunks(row);
      const removed = hunks.reduce((sum, hunk) => sum + linesOf(hunk.before).length, 0);
      const added = hunks.reduce((sum, hunk) => sum + linesOf(hunk.after).length, 0);
      return { kind: "diff", meta: hunks.length > 0 ? `${hunks.length} か所 · −${removed} +${added}` : null, lines: diffLines(hunks) };
    }
    case "update_properties": {
      const snapshot = UpdatePropertiesSnapshotSchema.safeParse(row.snapshot);
      const requested = (row.request.properties ?? {}) as Record<string, unknown>;
      const entries = (snapshot.success ? snapshot.data.properties : []).map((entry) => {
        const raw = requested[entry.name] ?? requested[entry.id];
        return {
          name: entry.name,
          before: renderPropertyValue(entry.value) || "（空）",
          after: (raw === undefined ? "" : renderRequestedPropertyValue(entry.type, raw)) || "（空）",
        };
      });
      return { kind: "properties", meta: entries.length > 0 ? `${entries.length} 件` : null, entries };
    }
    case "create_page":
      return { kind: "created", title: auditTitle(row), targetUrl: row.targetUrl };
    case "archive_page":
      return { kind: "archived" };
    case "revert":
      return {
        kind: "revert",
        of: row.revertOfAuditId !== null ? { id: row.revertOfAuditId, href: dashboardAuditPath(row.revertOfAuditId) } : null,
      };
  }
}

export type RevertView =
  { state: "reverted"; revert: { id: number; href: string } | null; note: string | null } | { state: "disabled" } | { state: "ready" };

export interface AuditDetailData {
  id: number;
  operation: string;
  badges: BadgeView[];
  summary: string;
  change: ChangeView;
  details: {
    userName: string;
    username: string | null;
    avatarUrl: string | null;
    title: string;
    targetUrl: string | null;
    createdAt: string;
    comment: { kind: "error"; text: string } | { kind: "posted" } | { kind: "none" };
    error: { label: string; text: string; failed: boolean } | null;
  };
  /** Null when the row cannot be reverted (failed writes, reverts) and for non-admin viewers. */
  revert: RevertView | null;
}

function parseAuditId(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

export async function auditDetail(deps: DashboardDeps, idParam: string, viewer: Pick<Viewer, "isAdmin">): Promise<AuditDetailData | null> {
  const id = parseAuditId(idParam);
  const row = id === null ? null : await deps.audit.getAudit(id);
  if (!row) return null;
  const avatars = await deps.subjects.memberAvatars([row.discordUserId]);
  const revertible = viewer.isAdmin && row.operation !== "revert" && row.status === "ok";
  let revert: RevertView | null = null;
  if (revertible) {
    if (row.revertedAt) {
      revert = {
        state: "reverted",
        revert: row.revertAuditId !== null ? { id: row.revertAuditId, href: dashboardAuditPath(row.revertAuditId) } : null,
        note: row.revertNote,
      };
    } else {
      revert = deps.notionEnabled ? { state: "ready" } : { state: "disabled" };
    }
  }
  return {
    id: row.id,
    operation: AUDIT_OPERATION_LABELS[row.operation],
    badges: statusBadges(row),
    summary: summarySentence(row),
    change: changeView(row),
    details: {
      userName: row.discordDisplayName,
      username: row.discordUsername,
      avatarUrl: avatars.get(row.discordUserId) ?? null,
      title: auditTitle(row),
      targetUrl: row.targetUrl,
      createdAt: formatJst(row.createdAt),
      comment: row.commentError ? { kind: "error", text: row.commentError } : row.status === "ok" ? { kind: "posted" } : { kind: "none" },
      error: row.error ? { label: row.status === "failed" ? "エラー" : "注記", text: row.error, failed: row.status === "failed" } : null,
    },
    revert,
  };
}

/** `conflict` asks the page to offer a forced revert (the page changed after the write). */
export interface RevertActionResult {
  result: ActionResult;
  conflict: boolean;
}

/** Null when the entry does not exist. */
export async function revertAudit(deps: DashboardDeps, idParam: string, form: FormData, actor: Viewer): Promise<RevertActionResult | null> {
  if (!actor.isAdmin) return { result: ADMIN_ONLY, conflict: false };
  const id = parseAuditId(idParam);
  if (id === null || !(await deps.audit.getAudit(id))) return null;
  const force = formString(form, "force") === "true";
  if (formString(form, "confirm") !== "yes") {
    return { result: { kind: "error", message: "確認のチェックを入れてから取り消してください。" }, conflict: force };
  }
  let outcome;
  try {
    outcome = await deps.audit.revert(id, {
      actorDiscordUserId: actor.discordUserId,
      actorDisplayName: actor.displayName,
      actorUsername: actor.username,
      force,
    });
  } catch (error) {
    deps.log({ event: "audit_revert", auditId: id, by: actor.discordUserId, force, ok: false, error: errorMessage(error) });
    return { result: { kind: "error", message: `取り消しに失敗しました: ${errorMessage(error)}` }, conflict: false };
  }
  deps.log({ event: "audit_revert", auditId: id, by: actor.discordUserId, force, ok: outcome.ok, revertAuditId: outcome.revertAuditId });
  if (outcome.ok) {
    const prefix = outcome.partial ? "一部のみ取り消しました。" : "取り消しました。";
    return { result: { kind: outcome.partial ? "warn" : "ok", message: `${prefix}${outcome.message}` }, conflict: false };
  }
  // The page explains the conflict and offers a forced revert instead of a message.
  if (outcome.conflict) return { result: { kind: "warn", message: null }, conflict: true };
  return { result: { kind: "error", message: `取り消せませんでした: ${outcome.message}` }, conflict: false };
}
