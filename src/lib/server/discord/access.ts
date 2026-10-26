import { ChannelType, type APIChannel, type APIThreadChannel } from "discord-api-types/v10";
import { ToolError } from "../lib/errors";
import { createLimiter } from "../lib/limiter";
import { compareSnowflakes, isSnowflake } from "../lib/snowflake";
import { TtlCache, systemClock, type Clock } from "../lib/ttl-cache";
import type { DiscordApi, GuildChannel } from "./api";
import { DISCORD_CACHE_TTL_MS, MAX_CACHED_PER_ID } from "./cache-policy";
import {
  ALL_PERMISSIONS,
  MANAGE_THREADS,
  canReadMessages,
  canViewChannel,
  computeChannelPermissions,
  hasPermission,
  toOverwrite,
} from "./permissions";
import type { GuildInfo, MemberInfo } from "./types";

export const DISCORD_NOT_ACCESSIBLE_MESSAGE = "Channel not found or not accessible.";

/** Thread checks that may ask Discord (private thread membership) run this many at once. */
export const THREAD_CHECK_CONCURRENCY = 5;

export class NotAccessibleError extends ToolError {
  constructor(message = DISCORD_NOT_ACCESSIBLE_MESSAGE) {
    super(message);
  }
}

/** Shown only for a channel the caller may read: it names no channel they could not know of. */
export const BOT_NO_ACCESS_MESSAGE =
  "This server's MCP bot has not been given access to this channel, so it cannot be read here. A server admin can add the bot to the channel.";

/** A channel the caller may read and whether the bot, which does the reading, may too. */
export interface ChannelReach {
  channel: GuildChannel;
  botCanRead: boolean;
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

export function isThread(channel: ResolvedChannel): channel is APIThreadChannel {
  return THREAD_TYPES.has(channel.type);
}

/** The channels listed to callers (no categories, directories or unknown kinds), with their kind's name. */
export const LISTED_CHANNEL_TYPES = new Map<ChannelType, string>([
  [ChannelType.GuildText, "text"],
  [ChannelType.GuildAnnouncement, "announcement"],
  [ChannelType.GuildForum, "forum"],
  [ChannelType.GuildMedia, "media"],
  [ChannelType.GuildVoice, "voice"],
  [ChannelType.GuildStageVoice, "stage"],
]);

/** Discord's own order: by position, then by id. */
export function byPosition(a: GuildChannel, b: GuildChannel): number {
  return (a.position ?? 0) - (b.position ?? 0) || compareSnowflakes(a.id, b.id);
}

/** A channel from the cached guild list or fetched by id. */
export type ResolvedChannel = GuildChannel | APIChannel;

export interface ReadableChannel {
  channel: ResolvedChannel;
  /** Parent channel for threads; null for regular channels. */
  parent: GuildChannel | null;
  permissions: bigint;
}

/** Guild channel list cached for a short TTL; threads are not part of this list. */
export class ChannelDirectory {
  private readonly cache: TtlCache<"channels", GuildChannel[]>;

  constructor(
    private readonly api: DiscordApi,
    options: { ttlMs?: number; clock?: Clock } = {},
  ) {
    this.cache = new TtlCache(options.ttlMs ?? DISCORD_CACHE_TTL_MS, options.clock ?? systemClock);
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

/** A channel as far as permissions go: its overwrites. */
type Overwritten = { permission_overwrites?: GuildChannel["permission_overwrites"] };

function channelPermissions(channel: Overwritten, viewer: Viewer): bigint {
  const overwrites = (channel.permission_overwrites ?? []).map(toOverwrite);
  return computeChannelPermissions(viewer.guild, viewer.member, overwrites);
}

/**
 * Answers "can this member see/read this channel or thread?" using bot-fetched data. The bot does
 * the reading, and Discord refuses it a channel it may not read whoever asks, so a channel is
 * readable here only when both the member and the bot may read it.
 */
export class ChannelAccess {
  private readonly threadMembers: TtlCache<string, boolean>;
  private readonly unlisted: TtlCache<string, APIChannel | null>;
  private readonly botMember: TtlCache<"bot", MemberInfo | null>;

  constructor(
    private readonly api: DiscordApi,
    private readonly channels: ChannelDirectory,
    private readonly guildId: string,
    options: { clock?: Clock } = {},
  ) {
    const clock = options.clock ?? systemClock;
    // Lookups the channel list cannot answer: threads (and unknown ids) by id, and private
    // thread membership per thread and viewer, which listing threads asks once per private thread.
    this.threadMembers = new TtlCache(DISCORD_CACHE_TTL_MS, clock, MAX_CACHED_PER_ID);
    this.unlisted = new TtlCache(DISCORD_CACHE_TTL_MS, clock, MAX_CACHED_PER_ID);
    this.botMember = new TtlCache(DISCORD_CACHE_TTL_MS, clock);
  }

  /** A channel missing from the channel list (a thread, or an unknown id), fetched by id. */
  fetchUnlisted(channelId: string): Promise<APIChannel | null> {
    return this.unlisted.getOrLoad(channelId, () => this.api.fetchChannel(channelId));
  }

  permissionsFor(channel: GuildChannel, viewer: Viewer): bigint {
    return channelPermissions(channel, viewer);
  }

  /** The bot as a viewer; null when it is not on the server, where every request fails anyway. */
  private async botViewer(guild: GuildInfo): Promise<Viewer | null> {
    const member = await this.botMember.getOrLoad("bot", () => this.api.fetchBotMember());
    return member ? { guild, member } : null;
  }

  /** The bot's permissions in a channel (for a thread, its parent), from its roles and the channel's overwrites. */
  async botPermissions(guild: GuildInfo): Promise<(channel: Overwritten) => bigint> {
    const bot = await this.botViewer(guild);
    return (channel) => (bot ? channelPermissions(channel, bot) : ALL_PERMISSIONS);
  }

  async listVisibleChannels(viewer: Viewer): Promise<Array<{ channel: GuildChannel; permissions: bigint }>> {
    const all = await this.channels.list();
    return all
      .map((channel) => ({ channel, permissions: channelPermissions(channel, viewer) }))
      .filter((entry) => canViewChannel(entry.permissions));
  }

  /** The listed channels whose messages the viewer may read, with whether the bot may too. */
  async readableChannels(viewer: Viewer): Promise<ChannelReach[]> {
    const botPermissions = await this.botPermissions(viewer.guild);
    return (await this.channels.list())
      .filter((channel) => LISTED_CHANNEL_TYPES.has(channel.type) && canReadMessages(channelPermissions(channel, viewer)))
      .map((channel) => ({ channel, botCanRead: canReadMessages(botPermissions(channel)) }));
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
    const userId = viewer.member.userId;
    return this.threadMembers.getOrLoad(`${thread.id}:${userId}`, () => this.api.isThreadMember(thread.id, userId));
  }

  /** Private threads each cost a membership request, so a bounded number run at once. */
  async filterVisibleThreads(threads: readonly APIThreadChannel[], viewer: Viewer, requireRead = false): Promise<APIThreadChannel[]> {
    const limit = createLimiter(THREAD_CHECK_CONCURRENCY);
    const checks = await Promise.all(threads.map((thread) => limit(() => this.isThreadVisible(thread, viewer, requireRead))));
    return threads.filter((_, index) => checks[index]);
  }

  /**
   * Resolves a channel or thread the viewer may read messages from. Any failure
   * (unknown id, other guild, insufficient permissions) yields the same error so
   * that existence of invisible channels is never revealed.
   */
  async resolveReadable(channelId: string, viewer: Viewer): Promise<ReadableChannel> {
    const readable = await this.resolveViewerReadable(channelId, viewer);
    const bot = await this.botViewer(viewer.guild);
    if (bot && !(await this.botCanRead(readable.channel, bot))) throw new ToolError(BOT_NO_ACCESS_MESSAGE);
    return readable;
  }

  private async botCanRead(channel: ResolvedChannel, bot: Viewer): Promise<boolean> {
    // A private thread also needs the bot to be in it (or to manage threads), as for the viewer.
    if (isThread(channel)) return this.isThreadVisible(channel, bot, true);
    return canReadMessages(channelPermissions("permission_overwrites" in channel ? channel : {}, bot));
  }

  private async resolveViewerReadable(channelId: string, viewer: Viewer): Promise<ReadableChannel> {
    if (!isSnowflake(channelId)) throw new NotAccessibleError();

    const listed = await this.channels.find(channelId);
    if (listed) {
      const permissions = channelPermissions(listed, viewer);
      if (!canReadMessages(permissions)) throw new NotAccessibleError();
      if (listed.type === ChannelType.GuildCategory) {
        throw new ToolError("This is a category, which has no messages. Use discord_list_channels to pick a channel inside it.");
      }
      return { channel: listed, parent: null, permissions };
    }

    const fetched = await this.fetchUnlisted(channelId);
    if (!fetched || !("guild_id" in fetched) || fetched.guild_id !== this.guildId) throw new NotAccessibleError();

    if (isThread(fetched)) {
      if (!(await this.isThreadVisible(fetched, viewer, true))) throw new NotAccessibleError();
      const parent = fetched.parent_id ? ((await this.channels.find(fetched.parent_id)) ?? null) : null;
      if (!parent) throw new NotAccessibleError();
      return { channel: fetched, parent, permissions: channelPermissions(parent, viewer) };
    }

    const permissions = channelPermissions(fetched, viewer);
    if (!canReadMessages(permissions)) throw new NotAccessibleError();
    return { channel: fetched, parent: null, permissions };
  }
}
