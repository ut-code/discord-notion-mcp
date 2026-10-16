import { beforeAll, describe, expect, test } from "bun:test";
import { rangeParam, statsPage } from "../../src/lib/server/dashboard/stats";
import type { Permission } from "../../src/lib/server/permissions/permissions";
import { SubjectResolver } from "../../src/lib/server/dashboard/subjects";
import { openDatabase, runAppMigrations, type DatabaseHandle } from "../../src/lib/server/db/client";
import { CachedGuildDirectory } from "../../src/lib/server/discord/directory";
import { ToolCallStore } from "../../src/lib/server/usage/tool-calls";
import { jstDay } from "../../src/lib/server/lib/jst-day";
import { UsageStats } from "../../src/lib/server/usage/usage-stats";
import { insertAuditRow } from "../support/audit-rows";
import { FakeDiscordApi, makeMember } from "../support/fakes";

const U1 = "300000000000000001";
const U2 = "300000000000000002";
/** 2026-10-12 12:00 Japan time. */
const NOW = Date.UTC(2026, 9, 12, 3, 0);
/** A Japan-time moment in October 2026. */
const jst = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour - 9, minute));

function freshDatabase(): DatabaseHandle {
  const database = openDatabase(":memory:");
  runAppMigrations(database.db);
  return database;
}

function depsFor(database: DatabaseHandle) {
  const discord = new FakeDiscordApi();
  discord.members.set(U1, { ...makeMember(U1), nick: "Mina" });
  return {
    usage: new UsageStats(database.db),
    subjects: new SubjectResolver(new CachedGuildDirectory(discord), discord, () => {}),
    toolPermissions: new Map<string, Permission>([
      ["discord_read_messages", "discord:read"],
      ["notion_search", "notion:read"],
      ["notion_get_page", "notion:read"],
      ["notion_create_page", "notion:write"],
    ]),
  };
}

let deps: ReturnType<typeof depsFor>;
const reader = { canViewAudit: true };

beforeAll(async () => {
  const database = freshDatabase();
  const calls = new ToolCallStore(database.db);
  const rows: Array<[string, string, boolean, number, "error" | "rate_limited" | undefined, Date]> = [
    [U1, "notion_search", true, 100, undefined, jst(12, 10)],
    [U1, "notion_search", true, 300, undefined, jst(12, 0, 10)],
    [U1, "discord_read_messages", false, 50, "error", jst(12, 9)],
    [U1, "discord_read_messages", false, 0, "rate_limited", jst(12, 9, 1)],
    [U2, "notion_get_page", true, 200, undefined, jst(11, 23, 50)],
    [U2, "tool_a", true, 10, undefined, jst(10, 12)],
    [U2, "tool_b", true, 10, undefined, jst(10, 12)],
    [U2, "tool_c", true, 10, undefined, jst(10, 12)],
    [U2, "notion_search", true, 200, undefined, jst(4, 12)],
  ];
  for (const [discordUserId, tool, ok, durationMs, errorKind, createdAt] of rows) {
    calls.record({ discordUserId, tool, ok, durationMs, errorKind, error: errorKind ? "boom" : undefined, createdAt });
  }
  const base = { discordUserId: U1, discordDisplayName: "Mina", request: {} };
  await insertAuditRow(database.db, { ...base, operation: "create_page", status: "ok", createdAt: jst(12, 8) });
  await insertAuditRow(database.db, { ...base, operation: "edit_content", status: "failed", createdAt: jst(12, 8, 30) });
  await insertAuditRow(database.db, { ...base, operation: "revert", status: "ok", createdAt: jst(11, 18) });
  await insertAuditRow(database.db, { ...base, operation: "create_page", status: "ok", createdAt: jst(1, 18) });
  deps = depsFor(database);
});

describe("usage statistics", () => {
  test("the range defaults to 30 days and accepts 7, 30 and 90", () => {
    expect(rangeParam(null)).toBe(30);
    expect(rangeParam("5")).toBe(30);
    expect(rangeParam("7")).toBe(7);
    expect(rangeParam("90")).toBe(90);
  });

  test("days are bucketed in Japan time", () => {
    expect(jstDay(jst(12, 0, 10).getTime())).toBe(jstDay(jst(12, 23, 59).getTime()));
    expect(jstDay(jst(12, 0, 0).getTime())).toBe(jstDay(jst(11, 23, 59).getTime()) + 1);
  });

  test("daily calls are stacked by the permission each tool needs", async () => {
    const data = await statsPage(deps, new URLSearchParams("range=7"), reader, NOW);
    expect(data.range).toBe(7);
    expect(data.ranges).toEqual([
      { label: "7日", href: "/dashboard?range=7", active: true },
      { label: "30日", href: "/dashboard", active: false },
      { label: "90日", href: "/dashboard?range=90", active: false },
    ]);
    expect(data.daily.series.map((entry) => [entry.key, entry.label])).toEqual([
      ["discord:read", "Discord 閲覧"],
      ["notion:read", "Notion 閲覧"],
      ["other", "その他"],
    ]);
    expect(data.daily.rows.map((row) => row.date)).toEqual(["10/06", "10/07", "10/08", "10/09", "10/10", "10/11", "10/12"]);
    expect(data.daily.rows.at(-1)).toEqual({ date: "10/12", counts: { "discord:read": 2, "notion:read": 2, other: 0 } });
    expect(data.daily.rows.at(-2)).toEqual({ date: "10/11", counts: { "discord:read": 0, "notion:read": 1, other: 0 } });
    expect(data.daily.rows.at(-3)).toEqual({ date: "10/10", counts: { "discord:read": 0, "notion:read": 0, other: 3 } });
  });

  test("summary, per-user and per-tool tables cover the range only", async () => {
    const data = await statsPage(deps, new URLSearchParams("range=7"), reader, NOW);
    expect(data.empty).toBe(false);
    expect(data.summary).toEqual({ calls: 8, activeUsers: 2, failureRate: "25.0%", rateLimited: 1 });
    expect(data.users).toEqual([
      { id: U1, name: "Mina", avatarUrl: null, calls: 4, failureRate: "50.0%", lastUsed: "10/12 10:00" },
      { id: U2, name: U2, avatarUrl: null, calls: 4, failureRate: "0.0%", lastUsed: "10/11 23:50" },
    ]);
    expect(data.tools.slice(0, 2)).toEqual([
      { tool: "discord_read_messages", calls: 2, failureRate: "100.0%", avgDuration: "25 ms" },
      { tool: "notion_search", calls: 2, failureRate: "0.0%", avgDuration: "200 ms" },
    ]);

    const month = await statsPage(deps, new URLSearchParams(), reader, NOW);
    expect(month.range).toBe(30);
    expect(month.daily.rows.length).toBe(30);
    expect(month.summary.calls).toBe(9);
    expect(month.tools[0]).toMatchObject({ tool: "notion_search", calls: 3 });
  });

  test("Notion writes, reverts and failures come from the audit log", async () => {
    const data = await statsPage(deps, new URLSearchParams("range=7"), reader, NOW);
    expect(data.notion).toEqual({ writes: 1, reverts: 1, failures: 1, auditHref: "/dashboard/audit" });
    expect((await statsPage(deps, new URLSearchParams("range=90"), reader, NOW)).notion.writes).toBe(2);
    expect((await statsPage(deps, new URLSearchParams("range=7"), { canViewAudit: false }, NOW)).notion.auditHref).toBeNull();
  });

  test("an empty log is reported as empty with zero-filled days", async () => {
    const data = await statsPage(depsFor(freshDatabase()), new URLSearchParams(), reader, NOW);
    expect(data.empty).toBe(true);
    expect(data.summary).toEqual({ calls: 0, activeUsers: 0, failureRate: "—", rateLimited: 0 });
    expect(data.daily.series).toEqual([]);
    expect(data.daily.rows.length).toBe(30);
    expect(data.users).toEqual([]);
  });
});
