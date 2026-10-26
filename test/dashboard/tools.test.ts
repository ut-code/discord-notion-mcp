import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord-api-types/v10";
import { z } from "zod";
import { channelsSection } from "../../src/lib/server/dashboard/channels";
import { toolsPage } from "../../src/lib/server/dashboard/tools";
import type { AnyToolDefinition } from "../../src/lib/server/mcp/registry";
import { toolListing } from "../../src/lib/server/mcp/tool-listing";
import { ChannelAccess, ChannelDirectory } from "../../src/lib/server/discord/access";
import { READ_MESSAGE_HISTORY, VIEW_CHANNEL } from "../../src/lib/server/discord/permissions";
import { BOT_ID, FakeDiscordApi, GUILD_ID, makeGuild, makeMember, textChannel } from "../../src/lib/server/fakes/discord";

function tool(name: string, permission: AnyToolDefinition["permission"], inputSchema: z.ZodObject): AnyToolDefinition {
  return { name, title: `Title of ${name}`, description: `Does ${name}.`, permission, inputSchema, handler: () => Promise.resolve("") };
}

const tools = [
  tool(
    "discord_search",
    "discord:read",
    z.object({
      query: z.string().describe("Words to search for"),
      has: z.array(z.enum(["image", "link"])).optional(),
      limit: z.number().int().default(25).describe("Results per page"),
      before: z.string().nullable(),
      tags: z.array(z.string().nullable()).optional(),
      order: z.enum(["asc", "desc"]).nullable(),
    }),
  ),
  tool("notion_archive", "notion:write", z.object({})),
].map(toolListing);

describe("tools page", () => {
  test("groups tools by permission and reads parameters off the schema the AI gets", () => {
    const data = toolsPage({ tools }, { permissions: ["discord:read"] });
    expect(data.groups.map((group) => [group.label, group.available, group.tools.map((entry) => entry.name)])).toEqual([
      ["Discord 閲覧", true, ["discord_search"]],
      ["Notion 編集", false, ["notion_archive"]],
    ]);
    const [search] = data.groups[0]!.tools;
    expect(search).toMatchObject({ title: "Title of discord_search", description: "Does discord_search." });
    expect(search!.parameters).toEqual([
      { name: "query", type: "string", required: true, description: "Words to search for", defaultValue: null },
      { name: "has", type: '("image" | "link")[]', required: false, description: null, defaultValue: null },
      { name: "limit", type: "integer", required: false, description: "Results per page", defaultValue: "25" },
      { name: "before", type: "string | null", required: true, description: null, defaultValue: null },
      { name: "tags", type: "(string | null)[]", required: false, description: null, defaultValue: null },
      { name: "order", type: '"asc" | "desc" | null', required: true, description: null, defaultValue: null },
    ]);
    expect(JSON.parse(search!.schema)).toEqual(tools[0]!.inputSchema);
    expect(data.groups[1]!.tools[0]!.parameters).toEqual([]);
  });
});

describe("tools page channels", () => {
  const STAFF_ROLE = "200000000000000001";
  const USER = "300000000000000001";
  const staffOnly = [
    { id: GUILD_ID, type: 0 as const, deny: VIEW_CHANNEL },
    { id: STAFF_ROLE, type: 0 as const, allow: VIEW_CHANNEL },
  ];

  function setup() {
    const api = new FakeDiscordApi();
    api.guild = makeGuild([
      { id: GUILD_ID, permissions: VIEW_CHANNEL | READ_MESSAGE_HISTORY },
      { id: STAFF_ROLE, permissions: 0n },
    ]);
    api.members.set(USER, makeMember(USER, [STAFF_ROLE]));
    api.members.set(BOT_ID, makeMember(BOT_ID));
    api.channels = [
      textChannel("400000000000000001", "staff", [], { type: ChannelType.GuildCategory, position: 1 }),
      textChannel("400000000000000002", "private-notes", staffOnly, { parent_id: "400000000000000001", position: 1 }),
      textChannel("400000000000000003", "staff-room", [...staffOnly, { id: BOT_ID, type: 1, allow: VIEW_CHANNEL }], {
        parent_id: "400000000000000001",
        position: 0,
      }),
      textChannel("400000000000000004", "welcome"),
    ];
    const channels = new ChannelDirectory(api);
    const errors: unknown[] = [];
    const deps = {
      directory: api,
      channels,
      channelAccess: new ChannelAccess(api, channels, GUILD_ID),
      logError: (entry: unknown) => errors.push(entry),
    };
    return { api, deps, errors };
  }

  test("lists by category what the viewer may read, marking what the bot may not", async () => {
    const { deps } = setup();
    const section = await channelsSection(deps, { discordUserId: USER, permissions: ["discord:read"] });
    if (section?.kind !== "channels") throw new Error("expected channels");
    expect(
      section.view.categories.map((group) => [group.name, group.channels.map((channel) => [channel.name, channel.botCanRead])]),
    ).toEqual([
      [null, [["welcome", true]]],
      [
        "staff",
        [
          ["staff-room", true],
          ["private-notes", false],
        ],
      ],
    ]);
    expect([section.view.accessibleCount, section.view.botlessCount]).toEqual([2, 1]);
    expect(section.view.categories[0]!.channels[0]!.href).toBe(`https://discord.com/channels/${GUILD_ID}/400000000000000004`);
  });

  test("is left out without the Discord permission, and says so when Discord fails", async () => {
    const { api, deps, errors } = setup();
    expect(await channelsSection(deps, { discordUserId: USER, permissions: ["notion:read"] })).toBeNull();
    api.fetchChannels = () => Promise.reject(new Error("Discord is unavailable"));
    const section = await channelsSection(deps, { discordUserId: USER, permissions: ["discord:read"] });
    expect(section?.kind).toBe("error");
    expect(errors).toEqual([{ event: "channel_list_failed", error: "Discord is unavailable" }]);
  });
});
