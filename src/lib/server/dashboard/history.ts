import { compareNames, formatNumber } from "../../locale";
import { m } from "../../paraglide/messages.js";
import { AUDIT_PATH, CALLS_PATH, toolPath } from "../../paths";
import type { NotionAuditOperation, ToolCallRow } from "../db/schema";
import type { Permission } from "../permissions/permissions";
import { CALL_RESULTS, TOOL_CALL_RETENTION_DAYS, type CallResult } from "../usage/tool-calls";
import type { Viewer } from "./access";
import type { DashboardDeps } from "./deps";
import type { BadgeView } from "./badges";
import { formatDuration, formatShortJst, PERMISSION_LABELS, type AuditStatusFilter } from "./format";
import { pageLinks, pageParam, userFilterParam, type Option } from "./shared";

/*
 * History, in the permission groups used everywhere else: the calls of the read tools
 * (kept for TOOL_CALL_RETENTION_DAYS), and the Notion write history, which records the changes
 * themselves and can revert them. Members see their own, admins everyone's.
 */

/** The read permissions whose tools' calls are listed; Notion edits have the write history. */
const CALL_PERMISSIONS = ["discord:read", "notion:read"] as const satisfies readonly Permission[];
type CallPermission = (typeof CALL_PERMISSIONS)[number];

const CALLS_PAGE_SIZE = 50;

type HistoryViewer = Pick<Viewer, "isAdmin" | "discordUserId" | "permissions">;
type HistoryDeps = Pick<DashboardDeps, "tools">;

/** Groups the viewer holds that have tools at all (no Notion tab when Notion is not configured). */
function viewerGroups<P extends Permission>(deps: HistoryDeps, viewer: HistoryViewer, groups: readonly P[]): P[] {
  return groups.filter(
    (permission) => viewer.permissions.includes(permission) && deps.tools.some((tool) => tool.permission === permission),
  );
}

export interface HistoryTab {
  label: string;
  href: string;
  active: boolean;
}

function callsHref(filters: { permission: CallPermission; user?: string; status?: CallResult }, page = 1): string {
  const params = new URLSearchParams({ permission: filters.permission });
  if (filters.user) params.set("user", filters.user);
  if (filters.status) params.set("status", filters.status);
  if (page > 1) params.set("page", String(page));
  return `${CALLS_PATH}?${params}`;
}

export interface AuditFilters {
  user?: string;
  operation?: NotionAuditOperation;
  status?: AuditStatusFilter;
}

/** The Notion write history (the Notion edit tab), filtered. */
export function auditListHref(filters: AuditFilters, page = 1): string {
  const params = new URLSearchParams();
  if (filters.user) params.set("user", filters.user);
  if (filters.operation) params.set("operation", filters.operation);
  if (filters.status) params.set("status", filters.status);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${AUDIT_PATH}?${query}` : AUDIT_PATH;
}

/** The tabs the viewer can open; `user` (admins only) follows them across tabs. */
export function historyTabs(deps: HistoryDeps, viewer: HistoryViewer, active: Permission | null, user: string | null): HistoryTab[] {
  const kept = viewer.isAdmin ? (user ?? undefined) : undefined;
  const tabs: HistoryTab[] = viewerGroups(deps, viewer, CALL_PERMISSIONS).map((permission) => ({
    label: PERMISSION_LABELS[permission],
    href: callsHref({ permission, user: kept }),
    active: active === permission,
  }));
  for (const permission of viewerGroups(deps, viewer, ["notion:write"] as const)) {
    tabs.push({ label: PERMISSION_LABELS[permission], href: auditListHref({ user: kept }), active: active === permission });
  }
  return tabs;
}

/** Where "History" leads: the first tab the viewer can open, for `user` when an admin passes one; null when none. */
export function historyHref(deps: HistoryDeps, viewer: HistoryViewer, user: string | null = null): string | null {
  return historyTabs(deps, viewer, null, user)[0]?.href ?? null;
}

const RESULT_BADGES: Record<CallResult, BadgeView> = {
  ok: { label: m.calls_result_ok(), tone: "success" },
  error: { label: m.calls_result_error(), tone: "destructive" },
  rate_limited: { label: m.calls_result_rate_limited(), tone: "warn" },
};

function resultOf(row: ToolCallRow): CallResult {
  return row.ok ? "ok" : (row.errorKind ?? "error");
}

interface CallRowView {
  id: number;
  createdAt: string;
  user: { id: string; name: string; avatarUrl: string | null };
  tool: string;
  toolHref: string;
  /** Every call's result, for tables. */
  status: BadgeView;
  /** Only for calls that did not succeed, for compact lists that flag exceptions. */
  badge: BadgeView | null;
  duration: string;
  /** Why it failed, as the server wrote it (never the arguments or the tool output). */
  error: string | null;
  /** One line under the tool in compact lists: "user · time · duration". */
  meta: string;
}

export interface CallsPageData {
  tabs: HistoryTab[];
  rows: CallRowView[];
  range: string | null;
  prevHref: string | null;
  nextHref: string | null;
  filters: { user: string; status: string };
  /** The tab, kept when filters change. */
  permission: CallPermission;
  canFilterUsers: boolean;
  userOptions: Option[];
  statusOptions: Option[];
  retention: string;
  /** Shown when the user filter is not a Discord id. */
  error: string | null;
}

function isCallPermission(value: string | null): value is CallPermission {
  return CALL_PERMISSIONS.some((permission) => permission === value);
}

function isCallResult(value: string | null): value is CallResult {
  return CALL_RESULTS.some((result) => result === value);
}

/** Null when the viewer may see no calls at all (no read permission). */
export async function callsPage(
  deps: Pick<DashboardDeps, "calls" | "tools" | "subjects">,
  params: URLSearchParams,
  viewer: HistoryViewer,
): Promise<CallsPageData | null> {
  const allowed = viewerGroups(deps, viewer, CALL_PERMISSIONS);
  const requested = params.get("permission");
  const permission = isCallPermission(requested) && allowed.includes(requested) ? requested : allowed[0];
  if (!permission) return null;

  const { user, error } = userFilterParam(params, viewer.isAdmin);
  const statusParam = params.get("status");
  const status = isCallResult(statusParam) ? statusParam : undefined;

  const tools = deps.tools.filter((tool) => tool.permission === permission).map((tool) => tool.name);
  const page = pageParam(params.get("page"));
  const { rows, total } = deps.calls.list({
    tools,
    discordUserId: viewer.isAdmin ? user : viewer.discordUserId,
    result: status,
    limit: CALLS_PAGE_SIZE,
    offset: (page - 1) * CALLS_PAGE_SIZE,
  });
  const callers = viewer.isAdmin ? deps.calls.callers(tools) : [];
  const people = await deps.subjects.resolveUsers(new Set([...rows.map((row) => row.discordUserId), ...callers, ...(user ? [user] : [])]));
  const nameOf = (id: string) => people.get(id)?.displayName ?? id;

  const userOptions = [...new Set([...callers, ...(user ? [user] : [])])]
    .map((id) => ({ value: id, label: nameOf(id) }))
    .sort((a, b) => compareNames(a.label, b.label));

  return {
    tabs: historyTabs(deps, viewer, permission, user ?? null),
    rows: rows.map((row) => {
      const createdAt = formatShortJst(row.createdAt);
      const duration = formatDuration(row.durationMs);
      const name = nameOf(row.discordUserId);
      return {
        id: row.id,
        createdAt,
        user: { id: row.discordUserId, name, avatarUrl: people.get(row.discordUserId)?.avatarUrl ?? null },
        tool: row.tool,
        toolHref: toolPath(row.tool),
        status: RESULT_BADGES[resultOf(row)],
        badge: row.ok ? null : RESULT_BADGES[resultOf(row)],
        duration,
        error: row.ok ? null : row.error,
        meta: [name, createdAt, duration].join(" · "),
      };
    }),
    ...pageLinks(page, CALLS_PAGE_SIZE, total, rows.length, (target) => callsHref({ permission, user, status }, target)),
    filters: { user: user ?? "", status: status ?? "" },
    permission,
    canFilterUsers: viewer.isAdmin,
    userOptions,
    statusOptions: CALL_RESULTS.map((value) => ({ value, label: RESULT_BADGES[value].label })),
    retention: m.calls_retention({ days: formatNumber(TOOL_CALL_RETENTION_DAYS) }),
    error,
  };
}
