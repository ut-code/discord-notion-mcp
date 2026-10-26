import { beforeEach, describe, expect, test } from "bun:test";
import { ChannelAccess, ChannelDirectory, DISCORD_NOT_ACCESSIBLE_MESSAGE } from "../../src/lib/server/discord/access";
import { MANAGE_THREADS, READ_MESSAGE_HISTORY, VIEW_CHANNEL } from "../../src/lib/server/discord/permissions";
import { BOT_ID, FakeDiscordApi, GUILD_ID, makeGuild, makeMember, textChannel, thread } from "../../src/lib/server/fakes/discord";

const USER = "300000000000000001";
const ROLE_STAFF = "200000000000000001";
const ROLE_THREAD_MOD = "200000000000000002";
const PUBLIC = "400000000000000001";
const STAFF = "400000000000000002";
const PUBLIC_THREAD = "500000000000000001";
const PRIVATE_THREAD = "500000000000000002";
const STAFF_THREAD = "500000000000000003";

let api: FakeDiscordApi;
let access: ChannelAccess;
let now = 0;

beforeEach(() => {
  api = new FakeDiscordApi();
  api.guild = makeGuild([
    { id: GUILD_ID, permissions: VIEW_CHANNEL | READ_MESSAGE_HISTORY },
    { id: ROLE_STAFF, permissions: 0n },
    { id: ROLE_THREAD_MOD, permissions: MANAGE_THREADS },
  ]);
  api.channels = [
    textChannel(PUBLIC, "public"),
    textChannel(STAFF, "staff", [
      { id: GUILD_ID, type: 0, deny: VIEW_CHANNEL },
      { id: ROLE_STAFF, type: 0, allow: VIEW_CHANNEL },
    ]),
  ];
  api.threads = [thread(PUBLIC_THREAD, PUBLIC), thread(PRIVATE_THREAD, PUBLIC, 12), thread(STAFF_THREAD, STAFF)];
  now = 0;
  access = new ChannelAccess(api, new ChannelDirectory(api, { clock: () => now }), GUILD_ID, { clock: () => now });
});

const viewer = (roles: string[] = []) => ({ guild: api.guild, member: makeMember(USER, roles) });

describe("ChannelAccess", () => {
  test("lists only viewable channels", async () => {
    expect((await access.listVisibleChannels(viewer())).map((e) => e.channel.id)).toEqual([PUBLIC]);
    expect((await access.listVisibleChannels(viewer([ROLE_STAFF]))).map((e) => e.channel.id)).toEqual([PUBLIC, STAFF]);
  });

  test("threads inherit parent visibility; private threads need membership", async () => {
    const visible = await access.filterVisibleThreads(api.threads, viewer());
    expect(visible.map((t) => t.id)).toEqual([PUBLIC_THREAD]);

    api.threadMembers.add(`${PRIVATE_THREAD}:${USER}`);
    now = 60_000;
    const asMember = await access.filterVisibleThreads(api.threads, viewer());
    expect(asMember.map((t) => t.id)).toEqual([PUBLIC_THREAD, PRIVATE_THREAD]);
  });

  test("private thread membership is cached for a minute per thread and viewer", async () => {
    await access.filterVisibleThreads(api.threads, viewer());
    await access.filterVisibleThreads(api.threads, viewer());
    expect(api.calls.threadMember).toBe(1);
    api.threadMembers.add(`${PRIVATE_THREAD}:${USER}`);
    expect((await access.filterVisibleThreads(api.threads, viewer())).map((t) => t.id)).not.toContain(PRIVATE_THREAD);
    now = 60_000;
    expect((await access.filterVisibleThreads(api.threads, viewer())).map((t) => t.id)).toContain(PRIVATE_THREAD);
    expect(api.calls.threadMember).toBe(2);
  });

  test("a private thread the viewer is in but the bot is not cannot be read here", async () => {
    api.members.set(BOT_ID, makeMember(BOT_ID));
    api.threadMembers.add(`${PRIVATE_THREAD}:${USER}`);
    await expect(access.resolveReadable(PRIVATE_THREAD, viewer())).rejects.toThrow("MCP bot has not been given access");
    api.threadMembers.add(`${PRIVATE_THREAD}:${BOT_ID}`);
    now = 60_000;
    expect((await access.resolveReadable(PRIVATE_THREAD, viewer())).channel.id).toBe(PRIVATE_THREAD);
  });

  test("MANAGE_THREADS sees private threads without membership", async () => {
    const visible = await access.filterVisibleThreads(api.threads, viewer([ROLE_THREAD_MOD]));
    expect(visible.map((t) => t.id)).toContain(PRIVATE_THREAD);
  });

  test("invisible, unknown and foreign channels yield the same error", async () => {
    const foreign = { ...thread("500000000000000009", PUBLIC), guild_id: "999999999999999999" };
    api.threads.push(foreign);
    for (const id of [STAFF, STAFF_THREAD, PRIVATE_THREAD, foreign.id, "499999999999999999", "not-an-id"]) {
      await expect(access.resolveReadable(id, viewer())).rejects.toThrow(DISCORD_NOT_ACCESSIBLE_MESSAGE);
    }
  });

  test("resolves readable channels and threads", async () => {
    expect((await access.resolveReadable(PUBLIC, viewer())).channel.id).toBe(PUBLIC);
    const resolved = await access.resolveReadable(STAFF_THREAD, viewer([ROLE_STAFF]));
    expect(resolved.channel.id).toBe(STAFF_THREAD);
    expect(resolved.parent?.id).toBe(STAFF);
  });

  test("threads, which the channel list leaves out, are looked up once a minute", async () => {
    await access.resolveReadable(STAFF_THREAD, viewer([ROLE_STAFF]));
    await access.resolveReadable(STAFF_THREAD, viewer([ROLE_STAFF]));
    expect(api.calls.channel).toBe(1);
    now = 60_000;
    await access.resolveReadable(STAFF_THREAD, viewer([ROLE_STAFF]));
    expect(api.calls.channel).toBe(2);
  });

  test("channel list is cached", async () => {
    await access.listVisibleChannels(viewer());
    await access.resolveReadable(PUBLIC, viewer());
    expect(api.calls.channels).toBe(1);
  });
});
