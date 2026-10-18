import type {
  APIChannel,
  APIGuildScheduledEvent,
  APIMessage,
  APIThreadChannel,
  RESTGetAPIGuildMessagesSearchQuery,
} from "discord-api-types/v10";
import type {
  ArchivedThreadsPage,
  DiscordApi,
  GuildChannel,
  MessageQuery,
  MessageSearchResponse,
  PinsPage,
} from "../../src/lib/server/discord/api";
import type { GuildInfo, ListedMember, MemberInfo, UserInfo } from "../../src/lib/server/discord/types";
import { compareSnowflakes } from "../../src/lib/server/lib/snowflake";

export const GUILD_ID = "100000000000000000";
export const OWNER_ID = "100000000000000001";

export class FakeClock {
  constructor(public now = 1_800_000_000_000) {}
  readonly fn = () => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

export function makeGuild(
  roles: Array<{ id: string; permissions: bigint; name?: string; color?: number; position?: number; managed?: boolean }> = [],
): GuildInfo {
  return {
    id: GUILD_ID,
    name: "Test Guild",
    iconUrl: null,
    ownerId: OWNER_ID,
    roles: [
      { id: GUILD_ID, name: "@everyone", permissions: 0n, color: 0, position: 0, managed: false },
      ...roles.map((role, index) => ({
        id: role.id,
        name: role.id === GUILD_ID ? "@everyone" : (role.name ?? `role-${role.id}`),
        permissions: role.permissions,
        color: role.color ?? 0,
        position: role.id === GUILD_ID ? 0 : (role.position ?? index + 1),
        managed: role.managed ?? false,
      })),
    ].reduce<GuildInfo["roles"]>((acc, role) => {
      const existing = acc.findIndex((r) => r.id === role.id);
      if (existing >= 0) acc[existing] = role;
      else acc.push(role);
      return acc;
    }, []),
  };
}

export function makeMember(userId: string, roles: string[] = []): MemberInfo {
  return { userId, roles, nick: null, username: `user${userId.slice(-4)}`, globalName: null, avatarUrl: null };
}

export function textChannel(
  id: string,
  name: string,
  overwrites: Array<{ id: string; type: 0 | 1; allow?: bigint; deny?: bigint }> = [],
  extra: Partial<GuildChannel> = {},
): GuildChannel {
  return {
    id,
    name,
    type: 0,
    guild_id: GUILD_ID,
    position: 0,
    permission_overwrites: overwrites.map((o) => ({
      id: o.id,
      type: o.type,
      allow: String(o.allow ?? 0n),
      deny: String(o.deny ?? 0n),
    })),
    ...extra,
  };
}

export function thread(id: string, parentId: string, type: 11 | 12 = 11, name = `thread-${id}`): APIThreadChannel {
  return {
    id,
    name,
    type,
    guild_id: GUILD_ID,
    parent_id: parentId,
    thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: "2026-10-01T00:00:00.000Z", locked: false },
  };
}

export function message(id: string, channelId: string, content: string, authorName = "alice"): APIMessage {
  return {
    id,
    channel_id: channelId,
    content,
    timestamp: "2026-10-12T14:03:00.000Z",
    type: 0,
    author: { id: "300000000000000001", username: authorName, global_name: null, discriminator: "0", avatar: null },
    mentions: [],
    attachments: [],
    embeds: [],
  } as unknown as APIMessage;
}

export class FakeDiscordApi implements DiscordApi {
  guild: GuildInfo = makeGuild();
  members = new Map<string, MemberInfo>();
  channels: GuildChannel[] = [];
  threads: APIThreadChannel[] = [];
  threadMembers = new Set<string>();
  messages = new Map<string, APIMessage[]>();
  events: APIGuildScheduledEvent[] = [];
  /** `fetchMessages({ around })` leaves out the message it centers on. */
  aroundOmitsTarget = false;
  /** Members listed as bots. */
  bots = new Set<string>();
  /** Users that are not guild members but exist on Discord. */
  users = new Map<string, UserInfo>();
  /** fetchMember throws for these user ids (simulates Discord outages). */
  failingMembers = new Set<string>();
  calls = { guild: 0, member: 0, channels: 0, channel: 0, threadMember: 0, messages: 0, message: 0, pins: 0 };

  async fetchGuild(): Promise<GuildInfo> {
    this.calls.guild++;
    return this.guild;
  }

  async fetchMember(userId: string): Promise<MemberInfo | null> {
    this.calls.member++;
    if (this.failingMembers.has(userId)) throw new Error("Discord is unavailable");
    return this.members.get(userId) ?? null;
  }

  async fetchChannels(): Promise<GuildChannel[]> {
    this.calls.channels++;
    return this.channels;
  }

  async fetchChannel(channelId: string): Promise<APIChannel | null> {
    this.calls.channel++;
    return (
      (this.channels.find((c) => c.id === channelId) as APIChannel | undefined) ?? this.threads.find((t) => t.id === channelId) ?? null
    );
  }

  async fetchActiveThreads(): Promise<APIThreadChannel[]> {
    return this.threads;
  }

  archivedQueries: Array<{ channelId: string; before?: string; limit: number }> = [];

  async fetchArchivedPublicThreads(channelId: string, query: { before?: string; limit: number }): Promise<ArchivedThreadsPage> {
    this.archivedQueries.push({ channelId, ...query });
    return { threads: [], hasMore: false };
  }

  async fetchMessages(channelId: string, query: MessageQuery): Promise<APIMessage[]> {
    this.calls.messages++;
    const all = [...(this.messages.get(channelId) ?? [])].sort((a, b) => compareSnowflakes(b.id, a.id));
    if (query.around) {
      const around = query.around;
      // Discord does not document whether `around` returns the message itself; tests try both.
      const target = all.findIndex((m) => m.id === around);
      if (this.aroundOmitsTarget && target >= 0) all.splice(target, 1);
      const newer = all
        .filter((m) => compareSnowflakes(m.id, around) > 0)
        .reverse()
        .slice(0, Math.floor(query.limit / 2))
        .reverse();
      const rest = all.filter((m) => compareSnowflakes(m.id, around) <= 0).slice(0, query.limit - newer.length);
      return [...newer, ...rest];
    }
    if (query.after) {
      const after = query.after;
      return all
        .filter((m) => compareSnowflakes(m.id, after) > 0)
        .reverse()
        .slice(0, query.limit)
        .reverse();
    }
    const before = query.before;
    return all.filter((m) => !before || compareSnowflakes(m.id, before) < 0).slice(0, query.limit);
  }

  async fetchMessage(channelId: string, messageId: string): Promise<APIMessage | null> {
    this.calls.message++;
    return this.messages.get(channelId)?.find((m) => m.id === messageId) ?? null;
  }

  /** Pinned messages per channel, most recently pinned first; the page cursor is an index here. */
  pins = new Map<string, APIMessage[]>();

  async fetchPins(channelId: string, query: { before?: string; limit: number }): Promise<PinsPage> {
    this.calls.pins++;
    const all = this.pins.get(channelId) ?? [];
    const start = query.before ? Number(query.before) : 0;
    const end = start + query.limit;
    return { messages: all.slice(start, end), hasMore: end < all.length, nextBefore: end < all.length ? String(end) : undefined };
  }

  async isThreadMember(threadId: string, userId: string): Promise<boolean> {
    this.calls.threadMember++;
    return this.threadMembers.has(`${threadId}:${userId}`);
  }

  async fetchScheduledEvents(): Promise<APIGuildScheduledEvent[]> {
    return this.events;
  }

  /** Queued search responses; when empty, returns no results. */
  searchResponses: MessageSearchResponse[] = [];
  searchQueries: RESTGetAPIGuildMessagesSearchQuery[] = [];

  async searchMessages(query: RESTGetAPIGuildMessagesSearchQuery): Promise<MessageSearchResponse> {
    this.searchQueries.push(query);
    return (
      this.searchResponses.shift() ?? {
        status: "ok",
        result: { doing_deep_historical_index: false, total_results: 0, messages: [] },
      }
    );
  }

  async searchMembers(query: string, limit: number): Promise<MemberInfo[]> {
    const prefix = query.toLowerCase();
    return [...this.members.values()]
      .filter((member) => [member.username, member.nick, member.globalName].some((name) => name?.toLowerCase().startsWith(prefix)))
      .slice(0, limit);
  }

  async listMembers(limit: number, after?: string): Promise<ListedMember[]> {
    return [...this.members.values()]
      .filter((member) => after === undefined || BigInt(member.userId) > BigInt(after))
      .sort((a, b) => (BigInt(a.userId) < BigInt(b.userId) ? -1 : 1))
      .slice(0, limit)
      .map((member) => ({ ...member, bot: this.bots.has(member.userId) }));
  }

  async fetchUser(userId: string): Promise<UserInfo | null> {
    const member = this.members.get(userId);
    if (member) return { id: userId, username: member.username, globalName: member.globalName, avatarUrl: member.avatarUrl };
    return this.users.get(userId) ?? null;
  }
}
