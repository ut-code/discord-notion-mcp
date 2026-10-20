import { beforeEach, describe, expect, test } from "bun:test";
import {
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  type APIGuildScheduledEvent,
  type APIMessage,
  type APIThreadChannel,
} from "discord-api-types/v10";
import { ChannelAccess, ChannelDirectory } from "../../src/lib/server/discord/access";
import type { MessageSearchResponse } from "../../src/lib/server/discord/api";
import { ADMINISTRATOR, READ_MESSAGE_HISTORY, VIEW_CHANNEL } from "../../src/lib/server/discord/permissions";
import { searchReadableMessages } from "../../src/lib/server/discord/search";
import { createDiscordTools } from "../../src/lib/server/discord/tools";
import { dateToSnowflake } from "../../src/lib/server/lib/snowflake";
import type { AnyToolDefinition, Principal } from "../../src/lib/server/mcp/registry";
import { FakeDiscordApi, GUILD_ID, makeGuild, makeMember, message, textChannel, thread } from "../support/fakes";

const USER = "300000000000000001";
const ROLE_STAFF = "200000000000000001";
const ROLE_ADMIN = "200000000000000002";
const PUBLIC = "400000000000000001";
const STAFF = "400000000000000002";
const NO_HISTORY = "400000000000000003";
const PUBLIC_THREAD = "500000000000000001";
const PRIVATE_THREAD = "500000000000000002";
const STAFF_THREAD = "500000000000000003";

let api: FakeDiscordApi;
let tool: AnyToolDefinition;
let findMember: AnyToolDefinition;
let listThreads: AnyToolDefinition;
let listEvents: AnyToolDefinition;
let slept: number[];

function principal(roles: string[] = []): Principal {
  return {
    userId: "u",
    discordUserId: USER,
    access: {
      isMember: true,
      discordUserId: USER,
      guild: api.guild,
      member: makeMember(USER, roles),
      permissions: new Set(["discord:read"]),
      isAdmin: false,
    },
  };
}

async function search(args: Record<string, unknown>, roles: string[] = []): Promise<string> {
  const result = await tool.handler(tool.inputSchema.parse(args), { principal: principal(roles) });
  return typeof result === "string" ? result : JSON.stringify(result);
}

function results(messages: APIMessage[], threads: APIThreadChannel[] = [], total = messages.length): MessageSearchResponse {
  return {
    status: "ok",
    result: { doing_deep_historical_index: false, total_results: total, messages: messages.map((m) => [m]), threads },
  };
}

beforeEach(() => {
  api = new FakeDiscordApi();
  api.guild = makeGuild([
    { id: GUILD_ID, permissions: VIEW_CHANNEL | READ_MESSAGE_HISTORY },
    { id: ROLE_STAFF, permissions: 0n },
    { id: ROLE_ADMIN, permissions: ADMINISTRATOR },
  ]);
  api.channels = [
    textChannel(PUBLIC, "public"),
    textChannel(STAFF, "staff", [
      { id: GUILD_ID, type: 0, deny: VIEW_CHANNEL },
      { id: ROLE_STAFF, type: 0, allow: VIEW_CHANNEL },
    ]),
  ];
  api.threads = [thread(PUBLIC_THREAD, PUBLIC), thread(PRIVATE_THREAD, PUBLIC, 12), thread(STAFF_THREAD, STAFF)];
  slept = [];
  const channels = new ChannelDirectory(api);
  const access = new ChannelAccess(api, channels, GUILD_ID);
  const tools = createDiscordTools({
    api,
    access,
    channels,
    guildId: GUILD_ID,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  tool = tools.find((t) => t.name === "discord_search_messages")!;
  findMember = tools.find((t) => t.name === "discord_find_member")!;
  listThreads = tools.find((t) => t.name === "discord_list_threads")!;
  listEvents = tools.find((t) => t.name === "discord_list_events")!;
});

describe("discord_list_threads", () => {
  const list = async (args: Record<string, unknown>) =>
    listThreads.handler(listThreads.inputSchema.parse(args), { principal: principal() });

  test("passes a valid `before` to Discord as an ISO timestamp", async () => {
    await list({ channel_id: PUBLIC, before: "2026-10-01T12:34:56.789000+00:00" });
    await list({ channel_id: PUBLIC, before: "2026-10-01T09:00:00+09:00", limit: 5 });
    expect(api.archivedQueries).toEqual([
      { channelId: PUBLIC, before: "2026-10-01T12:34:56.789Z", limit: 50 },
      { channelId: PUBLIC, before: "2026-10-01T00:00:00.000Z", limit: 5 },
    ]);
  });

  test("rejects a `before` that is not an ISO datetime with a time zone", async () => {
    for (const before of ["yesterday", "2026-10-01", "2026-10-01T00:00:00"]) {
      await expect(list({ channel_id: PUBLIC, before })).rejects.toThrow(
        'Invalid "before": expected an ISO 8601 datetime with a time zone',
      );
    }
    expect(api.archivedQueries).toEqual([]);
  });

  test("archived threads are listed only to viewers who can read the channel's history, as in Discord", async () => {
    api.channels.push(textChannel(NO_HISTORY, "announcements", [{ id: GUILD_ID, type: 0, deny: READ_MESSAGE_HISTORY }]));
    const text = await list({ channel_id: NO_HISTORY });
    expect(text).toContain("Archived public: not listed (you cannot read this channel's message history).");
    expect(api.archivedQueries).toEqual([]);
  });
});

describe("discord_list_events", () => {
  function event(id: string, name: string, start: string, location: { channelId: string } | { external: string }): APIGuildScheduledEvent {
    const base = { id, guild_id: GUILD_ID, name, scheduled_start_time: start, status: GuildScheduledEventStatus.Scheduled };

    return ("channelId" in location
      ? { ...base, channel_id: location.channelId, entity_type: GuildScheduledEventEntityType.Voice }
      : {
          ...base,
          channel_id: null,
          entity_type: GuildScheduledEventEntityType.External,
          entity_metadata: { location: location.external },
        }) as unknown as APIGuildScheduledEvent;
  }

  test("lists events in viewable channels and external ones by start time, hiding the rest", async () => {
    api.events = [
      event("600000000000000001", "Later", "2026-10-21T10:00:00+00:00", { channelId: PUBLIC }),
      event("600000000000000002", "Staff only", "2026-10-20T09:00:00+00:00", { channelId: STAFF }),
      event("600000000000000003", "Meetup", "2026-10-20T10:00:00+00:00", { external: "Tokyo" }),
    ];
    const result = await listEvents.handler({}, { principal: principal() });
    const text = typeof result === "string" ? result : JSON.stringify(result);
    expect(text).not.toContain("Staff only");
    expect(text.indexOf("Meetup")).toBeLessThan(text.indexOf("Later"));
    expect(text).toContain("location: Tokyo");
    expect(text).toContain("location: #public");
    expect((await listEvents.handler({}, { principal: principal([ROLE_STAFF]) })) as string).toContain("Staff only");
  });
});

describe("discord_find_member", () => {
  async function find(args: Record<string, unknown>): Promise<string> {
    const result = await findMember.handler(findMember.inputSchema.parse(args), { principal: principal() });
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  beforeEach(() => {
    api.members.set("300000000000000010", {
      ...makeMember("300000000000000010", [ROLE_STAFF]),
      username: "tanaka",
      nick: "田中",
    });
    api.members.set("300000000000000011", { ...makeMember("300000000000000011"), username: "tanabe", globalName: "Tanabe" });
  });

  test("matches by username prefix with display name, id and roles", async () => {
    const text = await find({ query: "tana" });
    expect(text).toContain("- 田中 (@tanaka, id 300000000000000010) — roles: role-200000000000000001");
    expect(text).toContain("- Tanabe (@tanabe, id 300000000000000011)");
  });

  test("matches by nickname prefix and respects limit", async () => {
    expect(await find({ query: "田" })).toContain("@tanaka");
    expect(await find({ query: "tana", limit: 1 })).toContain("(1):");
  });

  test("an exact id fetches that member", async () => {
    expect(await find({ query: "300000000000000011" })).toContain("@tanabe");
    expect(await find({ query: "300000000000000099" })).toContain("No members match");
  });

  test("a name of digits only that is no member's id is still searched as a name", async () => {
    api.members.set("300000000000000012", { ...makeMember("300000000000000012"), username: "12345678901234567890" });
    expect(await find({ query: "12345678901234567" })).toContain("@12345678901234567890");
  });
});

describe("discord_search_messages scope", () => {
  test("restricted viewer searches only readable channels and visible active threads", async () => {
    await search({ query: "hello" });
    expect(api.searchQueries[0]!.channel_id).toEqual([PUBLIC, PUBLIC_THREAD]);
    expect(api.searchQueries[0]!.content).toBe("hello");
  });

  test("viewer who can read every channel searches guild-wide", async () => {
    await search({ query: "hello" }, [ROLE_STAFF]);
    expect(api.searchQueries[0]!.channel_id).toBeUndefined();
    await search({ query: "hello" }, [ROLE_ADMIN]);
    expect(api.searchQueries[1]!.channel_id).toBeUndefined();
  });

  test("channel_id must be readable and is passed alone", async () => {
    await search({ channel_id: PUBLIC_THREAD });
    expect(api.searchQueries[0]!.channel_id).toEqual([PUBLIC_THREAD]);
    await expect(search({ channel_id: STAFF })).rejects.toThrow("not found or not accessible");
    await expect(search({ channel_id: PRIVATE_THREAD })).rejects.toThrow("not found or not accessible");
  });

  test("maps filters, cursors and sort", async () => {
    await search({
      author_id: "300000000000000009",
      mentions_user_id: "300000000000000008",
      has: ["link", "file"],
      pinned: true,
      exclude_bots: true,
      after: "2026-10-01T00:00:00Z",
      before: "600000000000000000000",
      sort: "oldest",
      limit: 10,
      offset: 20,
    });
    const q = api.searchQueries[0]!;
    expect(q.author_id).toEqual(["300000000000000009"]);
    expect(q.mentions).toEqual(["300000000000000008"]);
    expect(q.has as string[]).toEqual(["link", "file"]);
    expect(q.pinned).toBe(true);
    expect(q.author_type as string[]).toEqual(["user"]);
    expect(q.min_id).toBe(dateToSnowflake(new Date("2026-10-01T00:00:00Z")));
    expect(q.max_id).toBe("600000000000000000000");
    expect(q.sort_by as string).toBe("timestamp");
    expect(q.sort_order).toBe("asc");
    expect(q.limit).toBe(10);
    expect(q.offset).toBe(20);

    await search({ query: "x", sort: "relevance" });
    expect(api.searchQueries[1]!.sort_by as string).toBe("relevance");
  });
});

describe("discord_search_messages results", () => {
  test("drops results from unreadable channels and private threads, hides total when filtered", async () => {
    api.searchResponses.push(
      results(
        [
          message("700000000000000001", PUBLIC, "visible hello"),
          message("700000000000000002", STAFF, "secret hello"),
          message("700000000000000003", PRIVATE_THREAD, "private hello"),
        ],
        [api.threads[1]!],
        3,
      ),
    );
    const text = await search({ query: "hello" });
    expect(text).toContain("visible hello");
    expect(text).not.toContain("secret hello");
    expect(text).not.toContain("private hello");
    expect(text).toContain("1 shown");
    expect(text).not.toContain("total");
  });

  test("returns only the threads of readable results", async () => {
    api.searchResponses.push(
      results(
        [message("700000000000000001", PUBLIC_THREAD, "open hello"), message("700000000000000003", PRIVATE_THREAD, "private hello")],
        [api.threads[0]!, api.threads[1]!],
      ),
    );
    const channels = new ChannelDirectory(api);
    const outcome = await searchReadableMessages(
      { api, access: new ChannelAccess(api, channels, GUILD_ID), channels },
      { guild: api.guild, member: makeMember(USER, []) },
      { content: "hello" },
    );
    expect(outcome.status === "ok" && outcome.threads.map((entry) => entry.id)).toEqual([PUBLIC_THREAD]);
  });

  test("private thread results are kept for thread members", async () => {
    api.threadMembers.add(`${PRIVATE_THREAD}:${USER}`);
    api.searchResponses.push(results([message("700000000000000003", PRIVATE_THREAD, "private hello")], [api.threads[1]!]));
    const text = await search({ query: "hello" });
    expect(text).toContain("private hello");
    expect(text).toContain(`#thread-${PRIVATE_THREAD}`);
    expect(text).toContain("1 total");
  });

  test("labels channels and suggests the next offset", async () => {
    api.searchResponses.push(results([message("700000000000000001", PUBLIC, "hello")], [], 40));
    const text = await search({ query: "hello", limit: 1 });
    expect(text).toContain("#public\n[2026-10-12 14:03 UTC]");
    expect(text).toContain("More: offset=1");
    expect(text).toContain(`https://discord.com/channels/${GUILD_ID}/${PUBLIC}/700000000000000001`);
  });

  test("a guild-wide search derives neither totals nor the More hint from Discord's total", async () => {
    const visible = [message("700000000000000001", PUBLIC, "first hello"), message("700000000000000002", PUBLIC, "second hello")];
    const hidden = message("700000000000000003", PRIVATE_THREAD, "private hello");
    const privateThread = api.threads[1]!;
    const run = async (response: MessageSearchResponse, limit: number) => {
      api.searchResponses.push(response);
      return search({ query: "hello", limit }, [ROLE_STAFF]);
    };

    // A page that is not full: no More hint, whatever Discord counted.
    const partial = await run(results(visible, [], 2), 3);
    expect(partial).toContain("Search results — 2 shown (offset 0)\n");
    expect(partial).not.toContain("More:");
    expect(await run(results([...visible, hidden], [privateThread], 3), 3)).toBe(partial);
    expect(await run(results(visible, [], 3), 3)).toBe(partial);
    expect(await run(results(visible, [], 500), 3)).toBe(partial);

    // A full page of readable results suggests the next one, with or without hidden hits elsewhere.
    const full = await run(results(visible, [], 2), 2);
    expect(full).toContain("Search results — 2 shown (offset 0)\nMore: offset=2");
    expect(await run(results(visible, [], 3), 2)).toBe(full);
    expect(full).not.toContain("private hello");
  });

  test("a page with dropped results shows no total and judges More by the readable page only", async () => {
    api.searchResponses.push(
      results([message("700000000000000001", PUBLIC, "visible hello"), message("700000000000000002", STAFF, "secret hello")], [], 40),
    );
    const text = await search({ query: "hello", limit: 2 });
    expect(text).toContain("Search results — 1 shown (offset 0)\n");
    expect(text).not.toContain("total");
    expect(text).not.toContain("More:");
  });

  test("waits while the index is being built, then returns results", async () => {
    api.searchResponses.push({ status: "indexing", retryAfterSeconds: 2 }, results([message("700000000000000001", PUBLIC, "hello")]));
    const text = await search({ query: "hello" });
    expect(slept).toEqual([2000]);
    expect(text).toContain("hello");
  });

  test("gives up after repeated indexing responses", async () => {
    for (let i = 0; i < 3; i++) api.searchResponses.push({ status: "indexing", retryAfterSeconds: 30 });
    const text = await search({ query: "hello" });
    expect(slept).toEqual([5000, 5000]);
    expect(text).toContain("still building the search index");
    expect(text).toContain("30 seconds");
  });

  test("rejects inverted cursors", async () => {
    await expect(search({ before: "2026-01-01T00:00:00Z", after: "2026-02-01T00:00:00Z" })).rejects.toThrow(
      '"before" must be later than "after"',
    );
  });
});
