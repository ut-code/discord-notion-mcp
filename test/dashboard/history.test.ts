import { beforeAll, describe, expect, test } from "bun:test";
import { callsPage, historyHref, historyTabs } from "../../src/lib/server/dashboard/history";
import { MemberRoster } from "../../src/lib/server/dashboard/member-roster";
import { SubjectResolver } from "../../src/lib/server/dashboard/subjects";
import { openDatabase, runAppMigrations } from "../../src/lib/server/db/client";
import { CachedGuildDirectory } from "../../src/lib/server/discord/directory";
import type { Permission } from "../../src/lib/server/permissions/permissions";
import { ToolCallStore } from "../../src/lib/server/usage/tool-calls";
import { FakeDiscordApi, makeMember } from "../../src/lib/server/fakes/discord";

const U1 = "300000000000000001";
const U2 = "300000000000000002";
const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 3, minute));

let deps: Parameters<typeof callsPage>[0];

beforeAll(() => {
  const database = openDatabase(":memory:");
  runAppMigrations(database.db);
  const calls = new ToolCallStore(database.db);
  calls.record({ discordUserId: U1, tool: "discord_read_messages", ok: true, durationMs: 120, createdAt: at(1) });
  calls.record({
    discordUserId: U1,
    tool: "discord_search_messages",
    ok: false,
    durationMs: 40,
    errorKind: "error",
    error: "Channel not found or not accessible.",
    createdAt: at(2),
  });
  calls.record({
    discordUserId: U1,
    tool: "discord_read_messages",
    ok: false,
    durationMs: 0,
    errorKind: "rate_limited",
    error: "Rate limit exceeded; retry in 3 s.",
    createdAt: at(3),
  });
  calls.record({ discordUserId: U2, tool: "discord_read_messages", ok: true, durationMs: 1500, createdAt: at(4) });
  calls.record({ discordUserId: U1, tool: "notion_search", ok: true, durationMs: 300, createdAt: at(5) });
  const discord = new FakeDiscordApi();
  discord.members.set(U1, { ...makeMember(U1), nick: "Mina" });
  discord.members.set(U2, { ...makeMember(U2), nick: "Kai" });
  const tools = (
    [
      ["discord_read_messages", "discord:read"],
      ["discord_search_messages", "discord:read"],
      ["notion_search", "notion:read"],
      ["notion_create_page", "notion:write"],
    ] satisfies Array<[string, Permission]>
  ).map(([name, permission]) => ({ name, title: name, description: "", inputSchema: {}, permission }));
  deps = { calls, tools, subjects: new SubjectResolver(new CachedGuildDirectory(discord), discord, new MemberRoster(discord), () => {}) };
});

const member = (permissions: Permission[]) => ({ isAdmin: false, discordUserId: U1, permissions });
const admin = {
  isAdmin: true,
  discordUserId: U2,
  permissions: ["discord:read", "notion:read", "notion:write", "admin"] satisfies Permission[],
};

describe("history tabs", () => {
  test("follow the permission groups the viewer has; History leads to the first", () => {
    expect(historyTabs(deps, member(["discord:read", "notion:read", "notion:write"]), "notion:read", null)).toEqual([
      { label: "Discord 閲覧", href: "/dashboard/calls?permission=discord%3Aread", active: false },
      { label: "Notion 閲覧", href: "/dashboard/calls?permission=notion%3Aread", active: true },
      { label: "Notion 編集", href: "/dashboard/audit", active: false },
    ]);
    expect(historyHref(deps, member(["notion:read"]))).toBe("/dashboard/calls?permission=notion%3Aread");
    expect(historyHref(deps, member([]))).toBeNull();
    // Only admins carry a user across tabs.
    expect(historyTabs(deps, admin, "discord:read", U1).map((tab) => tab.href)).toEqual([
      `/dashboard/calls?permission=discord%3Aread&user=${U1}`,
      `/dashboard/calls?permission=notion%3Aread&user=${U1}`,
      `/dashboard/audit?user=${U1}`,
    ]);
    expect(historyTabs(deps, member(["discord:read"]), "discord:read", U2)[0]!.href).toBe("/dashboard/calls?permission=discord%3Aread");
  });

  test("groups without tools get no tab, e.g. Notion when it is not configured", () => {
    const discordOnly = { tools: deps.tools.filter((tool) => tool.permission === "discord:read") };
    expect(historyTabs(discordOnly, admin, null, null).map((tab) => tab.label)).toEqual(["Discord 閲覧"]);
    expect(historyHref(discordOnly, member(["notion:read", "notion:write"]))).toBeNull();
  });
});

describe("call history", () => {
  test("members see their own calls of the tab's tools, newest first, with why they failed", async () => {
    const data = (await callsPage(deps, new URLSearchParams(`user=${U2}`), member(["discord:read"])))!;
    expect(data.permission).toBe("discord:read");
    expect(data.canFilterUsers).toBe(false);
    expect(data.rows.map((row) => [row.tool, row.status.label, row.badge?.label ?? null, row.error, row.duration])).toEqual([
      ["discord_read_messages", "レート制限", "レート制限", "Rate limit exceeded; retry in 3 s.", "0 ms"],
      ["discord_search_messages", "失敗", "失敗", "Channel not found or not accessible.", "40 ms"],
      ["discord_read_messages", "成功", null, null, "120 ms"],
    ]);
    expect(data.rows[0]).toMatchObject({ user: { id: U1, name: "Mina" }, toolHref: "/dashboard/tools#discord_read_messages" });
    expect(data.summary).toBe("3 件中 1–3 件・直近 90 日分を保存");
  });

  test("without rows the summary still says how long calls are kept", async () => {
    const data = (await callsPage(deps, new URLSearchParams("page=9"), member(["discord:read"])))!;
    expect(data.rows).toEqual([]);
    expect(data.summary).toBe("直近 90 日分を保存");
  });

  test("a tab the viewer lacks falls back to one they have; none at all lists nothing", async () => {
    const notion = (await callsPage(deps, new URLSearchParams("permission=discord:read"), member(["notion:read"])))!;
    expect(notion.permission).toBe("notion:read");
    expect(notion.rows.map((row) => row.tool)).toEqual(["notion_search"]);
    expect(await callsPage(deps, new URLSearchParams(), member([]))).toBeNull();
  });

  test("the status filters the list", async () => {
    const failed = (await callsPage(deps, new URLSearchParams("status=error"), member(["discord:read"])))!;
    expect(failed.rows.map((row) => row.tool)).toEqual(["discord_search_messages"]);
    expect(failed.filters).toEqual({ user: "", status: "error" });
  });

  test("admins see everyone's calls and can pick a user", async () => {
    const all = (await callsPage(deps, new URLSearchParams(), admin))!;
    expect(all.rows.map((row) => row.user.name)).toEqual(["Kai", "Mina", "Mina", "Mina"]);
    expect(all.userOptions).toEqual([
      { value: U2, label: "Kai" },
      { value: U1, label: "Mina" },
    ]);
    const one = (await callsPage(deps, new URLSearchParams(`user=${U2}`), admin))!;
    expect(one.rows.map((row) => row.duration)).toEqual(["1.5 s"]);
    expect((await callsPage(deps, new URLSearchParams("user=kai"), admin))!.error).toBe(
      "ユーザー ID は Discord の数値 ID で指定してください。",
    );
  });
});
