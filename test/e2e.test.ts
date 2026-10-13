import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { consentPage } from "../src/lib/server/dashboard/session";
import { toolCall } from "../src/lib/server/db/schema";
import { NO_PERMISSIONS_INSTRUCTIONS } from "../src/lib/server/mcp/server";
import { extractSignedOAuthQuery } from "../src/lib/server/dashboard/oauth-query";
import { GUILD_ID, makeGuild, makeMember, message, textChannel } from "./support/fakes";
import {
  authorize,
  exchangeCode,
  mcpCall as harnessMcpCall,
  REDIRECT_URI,
  refreshTokens,
  registerClient,
  sessionCookieFor,
  startHarness,
  type Harness,
} from "./support/harness";
import { READ_MESSAGE_HISTORY, VIEW_CHANNEL } from "../src/lib/server/discord/permissions";

const MEMBER_ID = "300000000000000001";
const OUTSIDER_ID = "300000000000000002";
const PUBLIC_CHANNEL = "400000000000000001";
const HIDDEN_CHANNEL = "400000000000000002";

let h: Harness;
const NOTION_READ_TOOLS = ["notion_get_comments", "notion_get_database", "notion_get_page", "notion_query_database", "notion_search"];
const NOTION_WRITE_TOOLS = [
  "notion_append_content",
  "notion_archive_page",
  "notion_create_page",
  "notion_edit_content",
  "notion_list_recent_changes",
  "notion_revert_change",
  "notion_update_properties",
];

const mcpCall = (token: string, body: unknown) => harnessMcpCall(h, token, body);

let accessToken = "";
let refreshToken = "";
let clientId = "";

beforeAll(async () => {
  h = await startHarness();
  const { discord } = h;
  discord.guild = makeGuild([{ id: GUILD_ID, permissions: VIEW_CHANNEL | READ_MESSAGE_HISTORY }]);
  discord.members.set(MEMBER_ID, { ...makeMember(MEMBER_ID), username: "alice", nick: "Ali" });
  discord.channels = [
    textChannel(PUBLIC_CHANNEL, "general"),
    textChannel(HIDDEN_CHANNEL, "secret", [{ id: GUILD_ID, type: 0, deny: VIEW_CHANNEL }]),
  ];
  discord.messages.set(PUBLIC_CHANNEL, [message("600000000000000001", PUBLIC_CHANNEL, "hello world")]);
});

afterAll(() => {
  h?.stop();
});

describe("OAuth + MCP end to end", () => {
  test("guild member completes authorize -> consent -> token", async () => {
    const { base } = h;
    clientId = await registerClient(h);
    const cookie = await sessionCookieFor(h, MEMBER_ID);

    const first = await authorize(h, clientId, cookie);
    expect(first.status).toBe(302);
    const consentUrl = new URL(first.headers.get("location")!, base);
    expect(consentUrl.pathname).toBe("/consent");

    const page = await consentPage(h.server.dashboard, consentUrl, new Headers({ cookie }));
    if (page.kind !== "ok") throw new Error(`consent page: ${page.kind}`);
    expect(page.data.clientName).toBe("E2E CLI");
    expect(page.data.account.name).toBe("Ali");
    expect(page.data.features).toEqual([]);

    const consent = await fetch(`${base}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ accept: true, oauth_query: extractSignedOAuthQuery(consentUrl.search) }),
    });
    expect(consent.status).toBe(200);
    const redirect = new URL(((await consent.json()) as { url: string }).url);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe("e2e-state");

    const tokens = await exchangeCode(h, clientId, redirect.searchParams.get("code")!);
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeString();
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token!;
  });

  test("member without grants connects (legacy protocol) but sees no tools", async () => {
    const init = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.protocolVersion).toBe("2025-06-18");
    expect(init.json.result.capabilities.tools).toBeDefined();
    expect(init.json.result.instructions).toBe(NO_PERMISSIONS_INSTRUCTIONS);

    const list = await mcpCall(accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    expect(list.json.result.tools).toEqual([]);
  });

  test("granting discord:read exposes the Discord tools, filtered by channel visibility", async () => {
    await h.server.grants.createGrant({ permission: "discord:read", subjectType: "user", subjectId: MEMBER_ID });

    const init = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
    });
    expect(init.json.result.serverInfo.name).toBe("discord-notion-mcp");
    expect(init.json.result.instructions).toBeUndefined();

    const list = await mcpCall(accessToken, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const names = (list.json.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(names).toEqual([
      "discord_find_member",
      "discord_get_message",
      "discord_list_channels",
      "discord_list_events",
      "discord_list_pins",
      "discord_list_threads",
      "discord_read_messages",
      "discord_search_messages",
    ]);

    const channels = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "discord_list_channels", arguments: {} },
    });
    const text = channels.json.result.content[0].text as string;
    expect(text).toContain("#general");
    expect(text).not.toContain("secret");

    const hidden = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "discord_read_messages", arguments: { channel_id: HIDDEN_CHANNEL } },
    });
    expect(hidden.json.result.isError).toBe(true);
    expect(hidden.json.result.content[0].text).toBe("Channel not found or not accessible.");

    const read = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "discord_read_messages", arguments: { channel_id: PUBLIC_CHANNEL } },
    });
    expect(read.json.result.content[0].text).toContain("alice (@alice): hello world");

    expect(h.toolLogs.map((entry) => [entry.tool, entry.ok, entry.discordUserId])).toEqual([
      ["discord_list_channels", true, MEMBER_ID],
      ["discord_read_messages", false, MEMBER_ID],
      ["discord_read_messages", true, MEMBER_ID],
    ]);
    const recorded = h.server.database.db.select().from(toolCall).orderBy(toolCall.id).all();
    expect(recorded.map((row) => [row.tool, row.ok, row.errorKind, row.discordUserId])).toEqual([
      ["discord_list_channels", true, null, MEMBER_ID],
      ["discord_read_messages", false, "error", MEMBER_ID],
      ["discord_read_messages", true, null, MEMBER_ID],
    ]);
  });

  test("Notion tools are hidden without notion permissions and appear per granted permission", async () => {
    const { notion } = h;
    const toolNames = async () => {
      const list = await mcpCall(accessToken, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
      return (list.json.result.tools as Array<{ name: string }>)
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("notion_"))
        .sort();
    };
    expect(await toolNames()).toEqual([]);

    await h.server.grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: MEMBER_ID });
    expect(await toolNames()).toEqual(NOTION_READ_TOOLS);

    const page = notion.addPage({ title: "Team wiki" });
    const search = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "notion_search", arguments: { query: "wiki" } },
    });
    expect(search.json.result.content[0].text).toContain(`Team wiki (id ${page.id})`);

    const denied = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "notion_create_page", arguments: { parent: page.id, title: "x" } },
    });
    expect(denied.json.result?.isError ?? denied.json.error).toBeTruthy();

    await h.server.grants.createGrant({ permission: "notion:write", subjectType: "user", subjectId: MEMBER_ID });
    expect(await toolNames()).toEqual([...NOTION_READ_TOOLS, ...NOTION_WRITE_TOOLS].sort());

    const created = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "notion_create_page", arguments: { parent: page.url, title: "Minutes", content: "- decided **X**" } },
    });
    const text = created.json.result.content[0].text as string;
    expect(text).toContain('Created page "Minutes"');
    expect(text).toContain("audit #1");
    expect(notion.comments.at(-1)!.text).toBe("🤖 Ali (@alice, Discord) が MCP 経由でページを作成しました — audit #1");
    expect(await h.server.notionAudit.getAudit(1)).toMatchObject({ discordUserId: MEMBER_ID, discordDisplayName: "Ali", status: "ok" });

    const changes = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "notion_list_recent_changes", arguments: {} },
    });
    expect(changes.json.result.content[0].text).toContain("- #1 ");

    const reverted = await mcpCall(accessToken, {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "notion_revert_change", arguments: { audit_id: 1 } },
    });
    expect(reverted.json.result.content[0].text).toBe("Reverted audit #1.");
  });

  test("refresh token rotates", async () => {
    const res = await refreshTokens(h, clientId, refreshToken);
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { access_token: string; refresh_token: string };
    expect(tokens.refresh_token).not.toBe(refreshToken);
  });

  test("non-member is sent to the not-member page instead of receiving a code", async () => {
    const cookie = await sessionCookieFor(h, OUTSIDER_ID);
    const res = await authorize(h, clientId, cookie);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, h.base).pathname).toBe("/not-member");
  });

  test("requests without a token get an RFC 9728 challenge", async () => {
    const res = await fetch(`${h.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${h.base}/.well-known/oauth-protected-resource/mcp"`);
  });
});
