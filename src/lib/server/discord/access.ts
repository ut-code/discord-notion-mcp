import { ChannelType, type APIChannel, type APIThreadChannel } from "discord-api-types/v10";
import { ToolError } from "../lib/errors";
import { isSnowflake } from "../lib/snowflake";
import { TtlCache, systemClock, type Clock } from "../lib/ttl-cache";
import type { DiscordApi, GuildChannel } from "./api";
import {
  MANAGE_THREADS,
  canReadMessages,
  canViewChannel,
  computeChannelPermissions,
  hasPermission,
  toOverwrite,
} from "./permissions";
import type { GuildInfo, MemberInfo } from "./types";

export const DISCORD_NOT_ACCESSIBLE_MESSAGE = "Channel not found or not accessible.";

export class NotAccessibleError extends ToolError {
  constructor(message = DISCORD_NOT_ACCESSIBLE_MESSAGE) {
    super(message);
  }
}

export interface Viewer {
  guild: GuildInfo;
  member: MemberInfo;
}

const THREAD_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

export function isThread(channel: APIChannel): channel is APIThreadChannel {
  return THREAD_TYPES.has(channel.type);
}

export interface ReadableChannel {
  channel: APIChannel;
  /** Parent channel for threads; null for regular channels. */
  parent: GuildChannel | null;
  permissions: bigint;
}

const CHANNEL_LIST_TTL_MS = 60_000;

/** Guild channel list cached for a short TTL; threads are not part of this list. */
export class ChannelDirectory {
  private readonly cache: TtlCache<"channels", GuildChannel[]>;

  constructor(
    private readonly api: DiscordApi,
    options: { ttlMs?: number; clock?: Clock } = {},
  ) {
    this.cache = new TtlCache(options.ttlMs ?? CHANNEL_LIST_TTL_MS, options.clock ?? systemClock);
  }

  list(): Promise<GuildChannel[]> {
    return this.cache.getOrLoad("channels", () => this.api.fetchChannels());
  }

  async find(channelId: string): Promise<GuildChannel | undefined> {
    return (await this.list()).find((channel) => channel.id === channelId);
  }

  async nameMap(): Promise<Map<string, string>> {
    return new Map((await this.list()).map((channel) => [channel.id, channel.name ?? channel.id]));
  }
}

function channelPermissions(channel: { permission_overwrites?: GuildChannel["permission_overwrites"] }, viewer: Viewer): bigint {
  const overwrites = (channel.permission_overwrites ?? []).map(toOverwrite);
  return computeChannelPermissions(viewer.guild, viewer.member, overwrites);
}

/** Answers "can this member see/read this channel or thread?" using bot-fetched data. */
export class ChannelAccess {
  constructor(
    private readonly api: DiscordApi,
    private readonly channels: ChannelDirectory,
    private readonly guildId: string,
  ) {}

  permissionsFor(channel: GuildChannel, viewer: Viewer): bigint {
    return channelPermissions(channel, viewer);
  }

  async listVisibleChannels(viewer: Viewer): Promise<Array<{ channel: GuildChannel; permissions: bigint }>> {
    const all = await this.channels.list();
    return all
      .map((channel) => ({ channel, permissions: channelPermissions(channel, viewer) }))
      .filter((entry) => canViewChannel(entry.permissions));
  }

  /** A thread is visible when its parent is viewable and, for private threads, the viewer is a member or can manage threads. */
  async isThreadVisible(thread: APIThreadChannel, viewer: Viewer, requireRead = false): Promise<boolean> {
    if (thread.guild_id && thread.guild_id !== this.guildId) return false;
    if (!thread.parent_id) return false;
    const parent = await this.channels.find(thread.parent_id);
    if (!parent) return false;
    const permissions = channelPermissions(parent, viewer);
    if (!(requireRead ? canReadMessages(permissions) : canViewChannel(permissions))) return false;
    if (thread.type !== ChannelType.PrivateThread) return true;
    if (hasPermission(permissions, MANAGE_THREADS)) return true;
    return this.api.isThreadMember(thread.id, viewer.member.userId);
  }

  async filterVisibleThreads(threads: readonly APIThreadChannel[], viewer: Viewer): Promise<APIThreadChannel[]> {
    const checks = await Promise.all(threads.map((thread) => this.isThreadVisible(thread, viewer)));
    return threads.filter((_, index) => checks[index]);
  }

  /**
   * Resolves a channel or thread the viewer may read messages from. Any failure
   * (unknown id, other guild, insufficient permissions) yields the same error so
   * that existence of invisible channels is never revealed.
   */
  async resolveReadable(channelId: string, viewer: Viewer): Promise<ReadableChannel> {
    if (!isSnowflake(channelId)) throw new NotAccessibleError();

    const listed = await this.channels.find(channelId);
    if (listed) {
      const permissions = channelPermissions(listed, viewer);
      if (!canReadMessages(permissions)) throw new NotAccessibleError();
      if (listed.type === ChannelType.GuildCategory) {
        throw new ToolError("This is a category, which has no messages. Use discord_list_channels to pick a channel inside it.");
      }
      return { channel: listed as APIChannel, parent: null, permissions };
    }

    const fetched = await this.api.fetchChannel(channelId);
    if (!fetched || !("guild_id" in fetched) || fetched.guild_id !== this.guildId) throw new NotAccessibleError();

    if (isThread(fetched)) {
      if (!(await this.isThreadVisible(fetched, viewer, true))) throw new NotAccessibleError();
      const parent = fetched.parent_id ? ((await this.channels.find(fetched.parent_id)) ?? null) : null;
      if (!parent) throw new NotAccessibleError();
      return { channel: fetched, parent, permissions: channelPermissions(parent, viewer) };
    }

    const permissions = channelPermissions(fetched as GuildChannel, viewer);
    if (!canReadMessages(permissions)) throw new NotAccessibleError();
    return { channel: fetched, parent: null, permissions };
  }
}
