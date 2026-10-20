import { DiscordAPIError, makeURLSearchParams, REST, type RateLimitData, type RequestData, type RouteLike } from "@discordjs/rest";
import {
  Routes,
  type APIGuild,
  type APIGuildChannel,
  type APIGuildMember,
  type APIGuildScheduledEvent,
  type APIMessage,
  type APIThreadChannel,
  type RESTGetAPIChannelMessagesPinsResult,
  type RESTGetAPIChannelThreadsArchivedPublicResult,
  type RESTGetAPIGuildThreadsResult,
  type APIChannel,
  type APIUser,
  type APIMessageSearchResult,
  type RESTGetAPIGuildMessagesSearchQuery,
  type RESTGetAPIGuildMessagesSearchResult,
} from "discord-api-types/v10";
import type { GuildDirectory } from "./directory";
import { guildIconUrl, memberAvatarUrl, userAvatarUrl } from "./avatar";
import type { GuildInfo, ListedMember, MemberInfo, UserInfo } from "./types";

/**
 * For tools, a rate limit is waited out when it lasts at most this long, as for Notion; a
 * longer one fails at once so the AI is told when to retry instead of hanging.
 */
const MAX_RATE_LIMIT_WAIT_MS = 2000;

/** Whether @discordjs/rest throws a RateLimitError at once instead of queueing the request. */
export function exceedsRateLimitWait(limit: Pick<RateLimitData, "retryAfter">): boolean {
  return limit.retryAfter > MAX_RATE_LIMIT_WAIT_MS;
}

/** A non-thread guild channel as returned by GET /guilds/{id}/channels. */
export type GuildChannel = APIGuildChannel & { position?: number; topic?: string | null };

/** Discord accepts one of `before`, `after` and `around` per request. */
export interface MessageQuery {
  before?: string;
  after?: string;
  around?: string;
  limit: number;
}

export interface PinsPage {
  messages: APIMessage[];
  hasMore: boolean;
  nextBefore?: string;
}

export interface ArchivedThreadsPage {
  threads: APIThreadChannel[];
  hasMore: boolean;
}

/** Thread list endpoints type `threads` as any channel, but only return thread channels. */
type ThreadsOnly<T extends { threads: APIChannel[] }> = Omit<T, "threads"> & { threads: APIThreadChannel[] };

/** Discord answers 202 with `retry_after` while the guild's search index is being built. */
export type MessageSearchResponse = { status: "ok"; result: APIMessageSearchResult } | { status: "indexing"; retryAfterSeconds: number };

/** Bot-authenticated Discord REST operations used by the tools. */
export interface DiscordApi extends GuildDirectory {
  fetchChannels(): Promise<GuildChannel[]>;
  /** Returns null when the channel does not exist or the bot cannot see it. */
  fetchChannel(channelId: string): Promise<APIChannel | null>;
  fetchActiveThreads(): Promise<APIThreadChannel[]>;
  fetchArchivedPublicThreads(channelId: string, query: { before?: string; limit: number }): Promise<ArchivedThreadsPage>;
  fetchMessages(channelId: string, query: MessageQuery): Promise<APIMessage[]>;
  fetchMessage(channelId: string, messageId: string): Promise<APIMessage | null>;
  fetchPins(channelId: string, query: { before?: string; limit: number }): Promise<PinsPage>;
  isThreadMember(threadId: string, userId: string): Promise<boolean>;
  fetchScheduledEvents(): Promise<APIGuildScheduledEvent[]>;
  searchMessages(query: RESTGetAPIGuildMessagesSearchQuery): Promise<MessageSearchResponse>;
  /** Guild members whose username or nickname starts with the query. */
  searchMembers(query: string, limit: number): Promise<MemberInfo[]>;
  /** A page of guild members by ascending user id, after the `after` id; needs the Server Members intent. */
  listMembers(limit: number, after?: string): Promise<ListedMember[]>;
  /** Returns null when the user does not exist. */
  fetchUser(userId: string): Promise<UserInfo | null>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DiscordAPIError && (error.status === 404 || error.status === 403);
}

function toMemberInfo(member: APIGuildMember, guildId: string, userId = member.user.id): MemberInfo {
  return {
    userId,
    roles: member.roles,
    nick: member.nick ?? null,
    username: member.user.username,
    globalName: member.user.global_name ?? null,
    avatarUrl: memberAvatarUrl(guildId, userId, member.avatar, member.user.avatar),
  };
}

export class RestDiscordApi implements DiscordApi {
  private readonly rest: REST;

  /**
   * `failFastOnRateLimit` is for tools. Sign-in, consent and the dashboard leave it off and
   * wait out any rate limit, since a person is waiting for them to go through.
   */
  constructor(
    botToken: string,
    private readonly guildId: string,
    options: { failFastOnRateLimit?: boolean } = {},
  ) {
    const rejectOnRateLimit = options.failFastOnRateLimit ? exceedsRateLimitWait : null;
    this.rest = new REST({ version: "10", rejectOnRateLimit }).setToken(botToken);
  }

  /** `rest.get` resolves to `unknown`; discord-api-types is the contract for the response of each route. */
  private async get<T>(route: RouteLike, options?: RequestData): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- trust boundary: Discord's REST response, typed by discord-api-types
    return (await this.rest.get(route, options)) as T;
  }

  async fetchGuild(): Promise<GuildInfo> {
    const guild = await this.get<APIGuild>(Routes.guild(this.guildId));
    return {
      id: guild.id,
      name: guild.name,
      iconUrl: guildIconUrl(guild.id, guild.icon),
      ownerId: guild.owner_id,
      roles: guild.roles.map((role) => ({
        id: role.id,
        name: role.name,
        permissions: BigInt(role.permissions),
        color: role.colors?.primary_color ?? role.color,
        position: role.position,
        managed: role.managed,
      })),
    };
  }

  async fetchMember(userId: string): Promise<MemberInfo | null> {
    try {
      const member = await this.get<APIGuildMember>(Routes.guildMember(this.guildId, userId));
      return toMemberInfo(member, this.guildId, userId);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.status === 404) return null;
      throw error;
    }
  }

  async fetchChannels(): Promise<GuildChannel[]> {
    return this.get<GuildChannel[]>(Routes.guildChannels(this.guildId));
  }

  async fetchChannel(channelId: string): Promise<APIChannel | null> {
    try {
      return await this.get<APIChannel>(Routes.channel(channelId));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async fetchActiveThreads(): Promise<APIThreadChannel[]> {
    const result = await this.get<ThreadsOnly<RESTGetAPIGuildThreadsResult>>(Routes.guildActiveThreads(this.guildId));
    return result.threads;
  }

  async fetchArchivedPublicThreads(channelId: string, query: { before?: string; limit: number }): Promise<ArchivedThreadsPage> {
    try {
      const result = await this.get<ThreadsOnly<RESTGetAPIChannelThreadsArchivedPublicResult>>(Routes.channelThreads(channelId, "public"), {
        query: makeURLSearchParams(query),
      });
      return { threads: result.threads, hasMore: result.has_more ?? false };
    } catch (error) {
      if (isNotFound(error)) return { threads: [], hasMore: false };
      throw error;
    }
  }

  async fetchMessages(channelId: string, query: MessageQuery): Promise<APIMessage[]> {
    return this.get<APIMessage[]>(Routes.channelMessages(channelId), { query: makeURLSearchParams(query) });
  }

  async fetchMessage(channelId: string, messageId: string): Promise<APIMessage | null> {
    try {
      return await this.get<APIMessage>(Routes.channelMessage(channelId, messageId));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async fetchPins(channelId: string, query: { before?: string; limit: number }): Promise<PinsPage> {
    const result = await this.get<RESTGetAPIChannelMessagesPinsResult>(Routes.channelMessagesPins(channelId), {
      query: makeURLSearchParams(query),
    });
    const last = result.items.at(-1);
    return {
      messages: result.items.map((item) => item.message),
      hasMore: result.has_more,
      nextBefore: last?.pinned_at,
    };
  }

  async isThreadMember(threadId: string, userId: string): Promise<boolean> {
    try {
      await this.rest.get(Routes.threadMembers(threadId, userId));
      return true;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.status === 404) return false;
      throw error;
    }
  }

  async fetchScheduledEvents(): Promise<APIGuildScheduledEvent[]> {
    return this.get<APIGuildScheduledEvent[]>(Routes.guildScheduledEvents(this.guildId));
  }

  async searchMessages(query: RESTGetAPIGuildMessagesSearchQuery): Promise<MessageSearchResponse> {
    const result = await this.get<RESTGetAPIGuildMessagesSearchResult>(Routes.guildMessagesSearch(this.guildId), {
      query: makeURLSearchParams(query),
    });
    if ("messages" in result) return { status: "ok", result };
    return { status: "indexing", retryAfterSeconds: result.retry_after ?? 1 };
  }

  async searchMembers(query: string, limit: number): Promise<MemberInfo[]> {
    const members = await this.get<APIGuildMember[]>(Routes.guildMembersSearch(this.guildId), {
      query: makeURLSearchParams({ query, limit }),
    });
    return members.map((member) => toMemberInfo(member, this.guildId));
  }

  async listMembers(limit: number, after?: string): Promise<ListedMember[]> {
    const members = await this.get<APIGuildMember[]>(Routes.guildMembers(this.guildId), {
      query: makeURLSearchParams({ limit, after }),
    });
    return members.map((member) => ({ ...toMemberInfo(member, this.guildId), bot: member.user.bot ?? false }));
  }

  async fetchUser(userId: string): Promise<UserInfo | null> {
    try {
      const user = await this.get<APIUser>(Routes.user(userId));
      return { id: user.id, username: user.username, globalName: user.global_name ?? null, avatarUrl: userAvatarUrl(user.id, user.avatar) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}
