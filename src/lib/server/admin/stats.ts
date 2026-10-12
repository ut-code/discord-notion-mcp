import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { DASHBOARD_PATH } from "../../paths";
import type { AppDatabase } from "../db/client";
import { notionAudit, toolCall } from "../db/schema";
import type { AdminDeps } from "./deps";
import { formatShortJst } from "./format";

export const STATS_PATH = `${DASHBOARD_PATH}/stats`;
export const STATS_RANGES = [7, 30, 90] as const;
export type StatsRange = (typeof STATS_RANGES)[number];
const DEFAULT_RANGE: StatsRange = 30;

const DAY_MS = 24 * 60 * 60_000;
const JST_OFFSET_MS = 9 * 60 * 60_000;
/** Tools stacked individually in the chart; the rest are summed as その他. */
const CHART_TOOLS = 5;
/** Categorical order (validated for adjacent stacked segments); その他 stays neutral. */
const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
const OTHER_COLOR = "#a1a1aa";
export const NOTION_SERIES = [
  { key: "writes", label: "書き込み", color: "#2a78d6" },
  { key: "reverts", label: "取り消し", color: "#eda100" },
  { key: "failures", label: "失敗", color: "#e34948" },
] as const;

/** Japan-time day number (days since the epoch in JST). */
export function jstDay(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
}

const jstDayExpr = (column: typeof toolCall.createdAt | typeof notionAudit.createdAt) =>
  sql<number>`cast((${column} + ${sql.raw(String(JST_OFFSET_MS))}) / ${sql.raw(String(DAY_MS))} as integer)`;
const failed = sql<number>`coalesce(sum(case when ${toolCall.ok} = 0 then 1 else 0 end), 0)`;

/** Aggregates over the tool call log and the Notion audit log since a point in time. */
export class UsageStats {
  constructor(private readonly db: AppDatabase) {}

  dailyByTool(since: Date): Array<{ day: number; tool: string; calls: number }> {
    const day = jstDayExpr(toolCall.createdAt);
    return this.db
      .select({ day, tool: toolCall.tool, calls: count() })
      .from(toolCall)
      .where(gte(toolCall.createdAt, since))
      .groupBy(day, toolCall.tool)
      .all();
  }

  byUser(since: Date): Array<{ discordUserId: string; calls: number; failures: number; lastUsed: Date }> {
    const rows = this.db
      .select({ discordUserId: toolCall.discordUserId, calls: count(), failures: failed, lastUsed: sql<number>`max(${toolCall.createdAt})` })
      .from(toolCall)
      .where(gte(toolCall.createdAt, since))
      .groupBy(toolCall.discordUserId)
      .orderBy(desc(count()), toolCall.discordUserId)
      .all();
    return rows.map((row) => ({ ...row, lastUsed: new Date(row.lastUsed) }));
  }

  byTool(since: Date): Array<{ tool: string; calls: number; failures: number; avgDurationMs: number }> {
    return this.db
      .select({ tool: toolCall.tool, calls: count(), failures: failed, avgDurationMs: sql<number>`avg(${toolCall.durationMs})` })
      .from(toolCall)
      .where(gte(toolCall.createdAt, since))
      .groupBy(toolCall.tool)
      .orderBy(desc(count()), toolCall.tool)
      .all();
  }

  rateLimited(since: Date): number {
    const [row] = this.db
      .select({ total: count() })
      .from(toolCall)
      .where(and(gte(toolCall.createdAt, since), eq(toolCall.errorKind, "rate_limited")))
      .all();
    return row?.total ?? 0;
  }

  notionDaily(since: Date): Array<{ day: number; writes: number; reverts: number; failures: number }> {
    const day = jstDayExpr(notionAudit.createdAt);
    const tally = (condition: ReturnType<typeof sql>) => sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`;
    return this.db
      .select({
        day,
        writes: tally(sql`${notionAudit.status} = 'ok' and ${notionAudit.operation} != 'revert'`),
        reverts: tally(sql`${notionAudit.status} = 'ok' and ${notionAudit.operation} = 'revert'`),
        failures: tally(sql`${notionAudit.status} = 'failed'`),
      })
      .from(notionAudit)
      .where(gte(notionAudit.createdAt, since))
      .groupBy(day)
      .all();
  }
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
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

export type NotionDay = {
  date: string;
  writes: number;
  reverts: number;
  failures: number;
};

export interface StatsPageData {
  range: StatsRange;
  ranges: Array<{ label: string; href: string; active: boolean }>;
  /** Nothing recorded in the range. */
  empty: boolean;
  summary: { calls: number; failureRate: string; rateLimited: number };
  /** Daily calls stacked by tool: one row per day, `date` plus a count per series key. */
  daily: { series: ChartSeries[]; rows: Array<Record<string, string | number>> };
  users: StatsUserRow[];
  tools: StatsToolRow[];
  notion: { series: ChartSeries[]; totals: { writes: number; reverts: number; failures: number }; rows: NotionDay[] };
}

export function rangeParam(value: string | null): StatsRange {
  const range = Number(value);
  return (STATS_RANGES as readonly number[]).includes(range) ? (range as StatsRange) : DEFAULT_RANGE;
}

function rangeHref(range: StatsRange): string {
  return range === DEFAULT_RANGE ? STATS_PATH : `${STATS_PATH}?range=${range}`;
}

const PERCENT = new Intl.NumberFormat("ja-JP", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatRate(failures: number, calls: number): string {
  return calls === 0 ? "—" : PERCENT.format(failures / calls);
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "10/12" of a JST day number. */
function dayLabel(day: number): string {
  const date = new Date(day * DAY_MS);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Query: `range` (7, 30 or 90 days, ending today in Japan time). */
export async function statsPage(deps: Pick<AdminDeps, "usage" | "subjects">, params: URLSearchParams, now = Date.now()): Promise<StatsPageData> {
  const range = rangeParam(params.get("range"));
  const firstDay = jstDay(now) - (range - 1);
  const since = new Date(firstDay * DAY_MS - JST_OFFSET_MS);
  const days = Array.from({ length: range }, (_, index) => firstDay + index);

  const usage = deps.usage;
  const daily = usage.dailyByTool(since);
  const byUser = usage.byUser(since);
  const byTool = usage.byTool(since);
  const rateLimited = usage.rateLimited(since);
  const notionDaily = new Map(usage.notionDaily(since).map((row) => [row.day, row]));
  const users = await deps.subjects.resolveUsers(byUser.map((row) => row.discordUserId));

  const top = byTool.slice(0, CHART_TOOLS).map((row) => row.tool);
  const series: ChartSeries[] = top.map((tool, index) => ({ key: `s${index}`, label: tool, color: SERIES_COLORS[index]! }));
  if (byTool.length > CHART_TOOLS) series.push({ key: "other", label: "その他", color: OTHER_COLOR });
  const keyOf = (tool: string) => {
    const index = top.indexOf(tool);
    return index >= 0 ? `s${index}` : "other";
  };
  const counts = new Map<number, Record<string, number>>();
  for (const row of daily) {
    const bucket = counts.get(row.day) ?? {};
    const key = keyOf(row.tool);
    bucket[key] = (bucket[key] ?? 0) + row.calls;
    counts.set(row.day, bucket);
  }

  const calls = byTool.reduce((sum, row) => sum + row.calls, 0);
  const failures = byTool.reduce((sum, row) => sum + row.failures, 0);
  const notionRows = days.map((day) => {
    const row = notionDaily.get(day);
    return { date: dayLabel(day), writes: row?.writes ?? 0, reverts: row?.reverts ?? 0, failures: row?.failures ?? 0 };
  });
  const notionTotals = notionRows.reduce(
    (sum, row) => ({ writes: sum.writes + row.writes, reverts: sum.reverts + row.reverts, failures: sum.failures + row.failures }),
    { writes: 0, reverts: 0, failures: 0 },
  );

  return {
    range,
    ranges: STATS_RANGES.map((value) => ({ label: `${value}日`, href: rangeHref(value), active: value === range })),
    empty: calls === 0 && notionTotals.writes + notionTotals.reverts + notionTotals.failures === 0,
    summary: { calls, failureRate: formatRate(failures, calls), rateLimited },
    daily: {
      series,
      rows: days.map((day) => {
        const bucket = counts.get(day) ?? {};
        return { date: dayLabel(day), ...Object.fromEntries(series.map((entry) => [entry.key, bucket[entry.key] ?? 0])) };
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
    notion: { series: NOTION_SERIES.map((entry) => ({ ...entry })), totals: notionTotals, rows: notionRows },
  };
}
