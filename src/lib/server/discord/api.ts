import { DiscordAPIError, makeURLSearchParams, REST } from "@discordjs/rest";
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
import { memberAvatarUrl, userAvatarUrl } from "./avatar";
import type { GuildInfo, MemberInfo, UserInfo } from "./types";

/** A non-thread guild channel as returned by GET /guilds/{id}/channels. */
export type GuildChannel = APIGuildChannel & { position?: number; topic?: string | null };

export interface MessageQuery {
  before?: string;
  after?: string;
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

  constructor(
    botToken: string,
    private readonly guildId: string,
  ) {
    this.rest = new REST({ version: "10" }).setToken(botToken);
  }

  async fetchGuild(): Promise<GuildInfo> {
    const guild = (await this.rest.get(Routes.guild(this.guildId))) as APIGuild;
    return {
      id: guild.id,
      name: guild.name,
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
      const member = (await this.rest.get(Routes.guildMember(this.guildId, userId))) as APIGuildMember;
      return toMemberInfo(member, this.guildId, userId);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.status === 404) return null;
      throw error;
    }
  }

  async fetchChannels(): Promise<GuildChannel[]> {
    return (await this.rest.get(Routes.guildChannels(this.guildId))) as GuildChannel[];
  }

  async fetchChannel(channelId: string): Promise<APIChannel | null> {
    try {
      return (await this.rest.get(Routes.channel(channelId))) as APIChannel;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async fetchActiveThreads(): Promise<APIThreadChannel[]> {
    const result = (await this.rest.get(Routes.guildActiveThreads(this.guildId))) as RESTGetAPIGuildThreadsResult;
    return result.threads as APIThreadChannel[];
  }

  async fetchArchivedPublicThreads(channelId: string, query: { before?: string; limit: number }): Promise<ArchivedThreadsPage> {
    try {
      const result = (await this.rest.get(Routes.channelThreads(channelId, "public"), {
        query: makeURLSearchParams(query),
      })) as RESTGetAPIChannelThreadsArchivedPublicResult;
      return { threads: result.threads as APIThreadChannel[], hasMore: result.has_more ?? false };
    } catch (error) {
      if (isNotFound(error)) return { threads: [], hasMore: false };
      throw error;
    }
  }

  async fetchMessages(channelId: string, query: MessageQuery): Promise<APIMessage[]> {
    return (await this.rest.get(Routes.channelMessages(channelId), { query: makeURLSearchParams(query) })) as APIMessage[];
  }

  async fetchMessage(channelId: string, messageId: string): Promise<APIMessage | null> {
    try {
      return (await this.rest.get(Routes.channelMessage(channelId, messageId))) as APIMessage;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async fetchPins(channelId: string, query: { before?: string; limit: number }): Promise<PinsPage> {
    const result = (await this.rest.get(Routes.channelMessagesPins(channelId), {
      query: makeURLSearchParams(query),
    })) as RESTGetAPIChannelMessagesPinsResult;
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
    return (await this.rest.get(Routes.guildScheduledEvents(this.guildId))) as APIGuildScheduledEvent[];
  }

  async searchMessages(query: RESTGetAPIGuildMessagesSearchQuery): Promise<MessageSearchResponse> {
    const result = (await this.rest.get(Routes.guildMessagesSearch(this.guildId), {
      query: makeURLSearchParams(query),
    })) as RESTGetAPIGuildMessagesSearchResult;
    if ("messages" in result) return { status: "ok", result };
    return { status: "indexing", retryAfterSeconds: result.retry_after ?? 1 };
  }

  async searchMembers(query: string, limit: number): Promise<MemberInfo[]> {
    const members = (await this.rest.get(Routes.guildMembersSearch(this.guildId), {
      query: makeURLSearchParams({ query, limit }),
    })) as APIGuildMember[];
    return members.map((member) => toMemberInfo(member, this.guildId));
  }

  async fetchUser(userId: string): Promise<UserInfo | null> {
    try {
      const user = (await this.rest.get(Routes.user(userId))) as APIUser;
      return { id: user.id, username: user.username, globalName: user.global_name ?? null, avatarUrl: userAvatarUrl(user.id, user.avatar) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}
