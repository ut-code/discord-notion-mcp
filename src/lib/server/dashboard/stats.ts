import { isOneOf } from "../../one-of";
import { m } from "../../paraglide/messages.js";
import { DASHBOARD_PATH } from "../../paths";
import type { Permission } from "../permissions/permissions";
import { DAY_MS, JST_OFFSET_MS, jstDay } from "../usage/usage-stats";
import type { Viewer } from "./access";
import { auditListHref } from "./audit";
import type { DashboardDeps } from "./deps";
import { formatShortJst, PERMISSION_LABELS } from "./format";

const STATS_PATH = DASHBOARD_PATH;
const STATS_RANGES = [7, 30, 90] as const;
export type StatsRange = (typeof STATS_RANGES)[number];
const DEFAULT_RANGE: StatsRange = 30;

/**
 * Chart groups in stacking order: the permission a tool needs, then tools no longer served.
 * Colors are palette slots defined per theme in app.css (the shadcn `--chart-N` convention).
 */
const CATEGORIES = [
  { key: "discord:read", label: PERMISSION_LABELS["discord:read"], color: "var(--chart-1)" },
  { key: "notion:read", label: PERMISSION_LABELS["notion:read"], color: "var(--chart-2)" },
  { key: "notion:write", label: PERMISSION_LABELS["notion:write"], color: "var(--chart-3)" },
  { key: "other", label: m.stats_category_other(), color: "var(--chart-4)" },
] as const;
type CategoryKey = (typeof CATEGORIES)[number]["key"];

export interface ChartSeries {
  key: string;
  label: string;
  /** A CSS color, e.g. `var(--chart-1)`. */
  color: string;
}

/** One bar: `counts` has a value for every series key. */
export interface ChartRow {
  date: string;
  counts: Record<string, number>;
}

export interface StatsUserRow {
  id: string;
  name: string;
  avatarUrl: string | null;
  calls: number;
  failureRate: string;
  lastUsed: string;
}

export interface StatsToolRow {
  tool: string;
  calls: number;
  failureRate: string;
  avgDuration: string;
}

export interface StatsPageData {
  range: StatsRange;
  ranges: Array<{ label: string; href: string; active: boolean }>;
  /** Nothing recorded in the range. */
  empty: boolean;
  summary: { calls: number; activeUsers: number; failureRate: string; rateLimited: number };
  /** Daily calls stacked by permission, one row per day. */
  daily: { series: ChartSeries[]; rows: ChartRow[] };
  users: StatsUserRow[];
  tools: StatsToolRow[];
  /** `auditHref` only for viewers who may open the write history. */
  notion: { writes: number; reverts: number; failures: number; auditHref: string | null };
}

export function rangeParam(value: string | null): StatsRange {
  const range = Number(value);
  return isOneOf(STATS_RANGES, range) ? range : DEFAULT_RANGE;
}

function rangeHref(range: StatsRange): string {
  return range === DEFAULT_RANGE ? STATS_PATH : `${STATS_PATH}?range=${range}`;
}

const PERCENT = new Intl.NumberFormat("ja-JP", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function formatRate(failures: number, calls: number): string {
  return calls === 0 ? "—" : PERCENT.format(failures / calls);
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "10/12" of a JST day number. */
function dayLabel(day: number): string {
  const date = new Date(day * DAY_MS);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

function categoryOf(permission: Permission | undefined): CategoryKey {
  return permission === "discord:read" || permission === "notion:read" || permission === "notion:write" ? permission : "other";
}

/** Query: `range` (7, 30 or 90 days, ending today in Japan time). */
export async function statsPage(
  deps: Pick<DashboardDeps, "usage" | "subjects" | "toolPermissions">,
  params: URLSearchParams,
  viewer: Pick<Viewer, "canViewAudit">,
  now = Date.now(),
): Promise<StatsPageData> {
  const range = rangeParam(params.get("range"));
  const firstDay = jstDay(now) - (range - 1);
  const since = new Date(firstDay * DAY_MS - JST_OFFSET_MS);
  const days = Array.from({ length: range }, (_, index) => firstDay + index);

  const usage = deps.usage;
  const daily = usage.dailyByTool(since);
  const byUser = usage.byUser(since);
  const byTool = usage.byTool(since);
  const rateLimited = usage.rateLimited(since);
  const notion = usage.notionTotals(since);
  const users = await deps.subjects.resolveUsers(byUser.map((row) => row.discordUserId));

  const counts = new Map<number, Partial<Record<CategoryKey, number>>>();
  const used = new Set<CategoryKey>();
  for (const row of daily) {
    const key = categoryOf(deps.toolPermissions.get(row.tool));
    const bucket = counts.get(row.day) ?? {};
    bucket[key] = (bucket[key] ?? 0) + row.calls;
    counts.set(row.day, bucket);
    used.add(key);
  }
  const usedCategories = CATEGORIES.filter((category) => used.has(category.key));
  const series: ChartSeries[] = usedCategories.map((category) => ({ ...category }));

  const calls = byTool.reduce((sum, row) => sum + row.calls, 0);
  const failures = byTool.reduce((sum, row) => sum + row.failures, 0);

  return {
    range,
    ranges: STATS_RANGES.map((value) => ({ label: m.stats_range_days({ days: value }), href: rangeHref(value), active: value === range })),
    empty: calls === 0 && notion.writes + notion.reverts + notion.failures === 0,
    summary: { calls, activeUsers: byUser.length, failureRate: formatRate(failures, calls), rateLimited },
    daily: {
      series,
      rows: days.map((day) => {
        const bucket = counts.get(day) ?? {};
        return { date: dayLabel(day), counts: Object.fromEntries(usedCategories.map(({ key }) => [key, bucket[key] ?? 0])) };
      }),
    },
    users: byUser.map((row) => {
      const user = users.get(row.discordUserId);
      return {
        id: row.discordUserId,
        name: user?.displayName ?? row.discordUserId,
        avatarUrl: user?.avatarUrl ?? null,
        calls: row.calls,
        failureRate: formatRate(row.failures, row.calls),
        lastUsed: formatShortJst(row.lastUsed),
      };
    }),
    tools: byTool.map((row) => ({
      tool: row.tool,
      calls: row.calls,
      failureRate: formatRate(row.failures, row.calls),
      avgDuration: formatDuration(row.avgDurationMs),
    })),
    notion: { ...notion, auditHref: viewer.canViewAudit ? auditListHref({}) : null },
  };
}
