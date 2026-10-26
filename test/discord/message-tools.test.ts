import { HTTPError } from "@discordjs/rest";
import { beforeEach, describe, expect, test } from "bun:test";
import { ChannelType } from "discord-api-types/v10";
import { ChannelAccess, ChannelDirectory } from "../../src/lib/server/discord/access";
import { READ_MESSAGE_HISTORY, VIEW_CHANNEL } from "../../src/lib/server/discord/permissions";
import { createDiscordTools } from "../../src/lib/server/discord/tools";
import type { AnyToolDefinition, Principal } from "../../src/lib/server/mcp/registry";
import { BOT_ID, FakeDiscordApi, GUILD_ID, makeGuild, makeMember, message, textChannel } from "../../src/lib/server/fakes/discord";

const USER = "300000000000000001";
const CHANNEL = "400000000000000001";
const id = (index: number) => String(600000000000000000n + BigInt(index));

let api: FakeDiscordApi;
let tools: Map<string, AnyToolDefinition>;

const principal = (): Principal => ({
  userId: "u",
  discordUserId: USER,
  access: {
    isMember: true,
    discordUserId: USER,
    guild: api.guild,
    member: makeMember(USER),
    permissions: new Set(["discord:read"]),
    isAdmin: false,
  },
});

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name)!;
  const result = await tool.handler(tool.inputSchema.parse(args), { principal: principal() });
  return typeof result === "string" ? result : JSON.stringify(result);
}

beforeEach(() => {
  api = new FakeDiscordApi();
  api.guild = makeGuild([{ id: GUILD_ID, permissions: VIEW_CHANNEL | READ_MESSAGE_HISTORY }]);
  api.channels = [textChannel(CHANNEL, "general")];
  api.messages.set(
    CHANNEL,
    Array.from({ length: 20 }, (_, index) => message(id(index), CHANNEL, `message ${index}`)),
  );
  const channels = new ChannelDirectory(api);
  tools = new Map(
    createDiscordTools({ api, access: new ChannelAccess(api, channels, GUILD_ID), channels, guildId: GUILD_ID }).map((tool) => [
      tool.name,
      tool,
    ]),
  );
});

describe("discord_get_message", () => {
  test("fetches the message and its context in one request, oldest first", async () => {
    const text = await call("discord_get_message", { channel_id: CHANNEL, message_id: id(10), context: 2 });
    const order = ["message 8", "message 9", "message 10", "message 11", "message 12"].map((content) => text.indexOf(content));
    expect(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(text).not.toContain("message 7");
    expect(text).not.toContain("message 13");
    expect(api.calls).toMatchObject({ messages: 1, message: 0 });
  });

  test("near the end of the channel the context is shorter on that side", async () => {
    const text = await call("discord_get_message", { channel_id: CHANNEL, message_id: id(19), context: 2 });
    expect(text).toContain("message 17");
    expect(text).not.toContain("message 16");
  });

  test("a message `around` leaves out is fetched on its own", async () => {
    api.aroundOmitsTarget = true;
    const text = await call("discord_get_message", { channel_id: CHANNEL, message_id: id(10), context: 1 });
    expect(text).toContain("message 10");
    expect(text).toContain("message 9");
    expect(text).toContain("message 11");
    expect(api.calls).toMatchObject({ messages: 1, message: 1 });
  });

  test("a Discord outage becomes a retry-later tool error", async () => {
    api.fetchMessages = () => Promise.reject(new HTTPError(503, "Service Unavailable", "GET", "https://discord.com/api", {}));
    await expect(call("discord_get_message", { channel_id: CHANNEL, message_id: id(3) })).rejects.toThrow(
      "Discord is not responding (HTTP 503); please retry in a moment.",
    );
  });

  test("an unknown message is not accessible", async () => {
    await expect(call("discord_get_message", { channel_id: CHANNEL, message_id: id(99) })).rejects.toThrow("not found or not accessible");
  });
});

describe("channel mentions", () => {
  test("name only the channels the reader can see", async () => {
    const HIDDEN = "400000000000000002";
    api.channels.push(textChannel(HIDDEN, "secret-plans", [{ id: GUILD_ID, type: 0, deny: VIEW_CHANNEL }]));
    api.messages.set(CHANNEL, [message(id(0), CHANNEL, `see <#${CHANNEL}> and <#${HIDDEN}>`)]);
    const text = await call("discord_read_messages", { channel_id: CHANNEL });
    expect(text).toContain(`see #general and <#${HIDDEN}>`);
    expect(text).not.toContain("secret-plans");
  });
});

describe("channels the bot cannot read", () => {
  const STAFF_ROLE = "200000000000000001";
  const STAFF_ONLY = "400000000000000003";

  beforeEach(() => {
    // Read by a role the user holds and the bot does not: Discord would refuse the bot.
    api.channels.push(
      textChannel(STAFF_ONLY, "staff", [
        { id: GUILD_ID, type: 0, deny: VIEW_CHANNEL },
        { id: STAFF_ROLE, type: 0, allow: VIEW_CHANNEL },
      ]),
    );
    api.members.set(BOT_ID, makeMember(BOT_ID));
    api.messages.set(STAFF_ONLY, [message(id(500), STAFF_ONLY, "staff only")]);
  });

  const staffCall = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name)!;
    const staff = principal();
    staff.access.member = makeMember(USER, [STAFF_ROLE]);
    const result = await tool.handler(tool.inputSchema.parse(args), { principal: staff });
    return typeof result === "string" ? result : JSON.stringify(result);
  };

  test("are listed as such, and reading one says the bot has no access", async () => {
    const list = await staffCall("discord_list_channels", {});
    expect(list).toContain(`#staff (id ${STAFF_ONLY}, text, not readable here: the MCP bot cannot read it)`);
    expect(list).toContain(`#general (id ${CHANNEL}, text)`);
    await expect(staffCall("discord_read_messages", { channel_id: STAFF_ONLY })).rejects.toThrow("MCP bot has not been given access");
    expect(api.calls.messages).toBe(0);
  });

  test("give a member who cannot read them the usual not-accessible error", async () => {
    await expect(call("discord_read_messages", { channel_id: STAFF_ONLY })).rejects.toThrow("Channel not found or not accessible.");
  });

  test("are readable once the bot holds the role", async () => {
    api.members.set(BOT_ID, makeMember(BOT_ID, [STAFF_ROLE]));
    expect(await staffCall("discord_read_messages", { channel_id: STAFF_ONLY })).toContain("staff only");
  });
});

describe("discord_read_messages on a forum", () => {
  test("points to its threads instead of an empty list", async () => {
    const FORUM = "400000000000000004";
    api.channels.push(textChannel(FORUM, "ideas", [], { type: ChannelType.GuildForum }));
    await expect(call("discord_read_messages", { channel_id: FORUM })).rejects.toThrow(
      `#ideas is a forum: each post is a thread. List them with discord_list_threads (channel_id "${FORUM}")`,
    );
  });
});

describe("discord_list_pins", () => {
  test("lists pins page by page up to 150 and says when more exist", async () => {
    api.pins.set(
      CHANNEL,
      Array.from({ length: 160 }, (_, index) => message(id(1000 + index), CHANNEL, `pin ${index}`)),
    );
    const text = await call("discord_list_pins", { channel_id: CHANNEL });
    expect(text).toContain("150 pinned message(s)");
    expect(text).toContain("(More pins exist; only the most recent 150 are shown.)");
    expect(api.calls.pins).toBe(3);

    api.pins.set(CHANNEL, [message(id(2000), CHANNEL, "only pin")]);
    expect(await call("discord_list_pins", { channel_id: CHANNEL })).not.toContain("More pins exist");
  });
});
