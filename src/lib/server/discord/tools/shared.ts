// Shared types, constants and helpers used by the Discord tool modules.
import { DiscordAPIError } from "@discordjs/rest";
import { ChannelType, GuildScheduledEventStatus, MessageSearchHasType, type APIThreadChannel } from "discord-api-types/v10";
import { ToolError } from "../../lib/errors";
import { compareSnowflakes, parseMessageCursor } from "../../lib/snowflake";
import type { Principal, ToolResult } from "../../mcp/registry";
import { NotAccessibleError, type ChannelAccess, type ChannelDirectory, type ResolvedChannel, type Viewer } from "../access";
import type { DiscordApi, GuildChannel } from "../api";
import { formatTimestamp, type FormatContext } from "../format";

export interface DiscordToolDeps {
  api: DiscordApi;
  access: ChannelAccess;
  channels: ChannelDirectory;
  guildId: string;
  /** Overridable for tests; used while waiting for Discord's search index. */
  sleep?: (ms: number) => Promise<void>;
}

export const SEARCH_HAS_TYPES = [
  MessageSearchHasType.Image,
  MessageSearchHasType.Sound,
  MessageSearchHasType.Video,
  MessageSearchHasType.File,
  MessageSearchHasType.Sticker,
  MessageSearchHasType.Embed,
  MessageSearchHasType.Link,
  MessageSearchHasType.Poll,
  MessageSearchHasType.Snapshot,
] as const;

export const LISTED_CHANNEL_TYPES = new Map<ChannelType, string>([
  [ChannelType.GuildText, "text"],
  [ChannelType.GuildAnnouncement, "announcement"],
  [ChannelType.GuildForum, "forum"],
  [ChannelType.GuildMedia, "media"],
  [ChannelType.GuildVoice, "voice"],
  [ChannelType.GuildStageVoice, "stage"],
]);

export const THREAD_LABELS = new Map<ChannelType, string>([
  [ChannelType.AnnouncementThread, "announcement thread"],
  [ChannelType.PublicThread, "public thread"],
  [ChannelType.PrivateThread, "private thread"],
]);

export const EVENT_STATUS = new Map<GuildScheduledEventStatus, string>([
  [GuildScheduledEventStatus.Scheduled, "scheduled"],
  [GuildScheduledEventStatus.Active, "active"],
  [GuildScheduledEventStatus.Completed, "completed"],
  [GuildScheduledEventStatus.Canceled, "canceled"],
]);

export function viewerOf(principal: Principal): Viewer {
  return { guild: principal.access.guild, member: principal.access.member };
}

/** Maps Discord "not found / forbidden" API errors to the uniform not-accessible tool error. */
export function withDiscordErrors<A>(handler: (args: A, principal: Principal) => Promise<ToolResult>) {
  return async (args: A, ctx: { principal: Principal }): Promise<ToolResult> => {
    try {
      return await handler(args, ctx.principal);
    } catch (error) {
      if (error instanceof DiscordAPIError && (error.status === 403 || error.status === 404)) {
        throw new NotAccessibleError("Not found or not accessible.");
      }
      if (error instanceof DiscordAPIError && error.status === 400) {
        throw new ToolError(`Discord rejected the request: ${error.message}`);
      }
      throw error;
    }
  };
}

export function parseCursor(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    return parseMessageCursor(value);
  } catch {
    throw new ToolError(`Invalid "${field}": expected a message id or an ISO 8601 datetime.`);
  }
}

export function channelLabel(channel: ResolvedChannel): string {
  const name = "name" in channel && channel.name ? channel.name : channel.id;
  return `#${name}`;
}

export async function formatContextFor(deps: DiscordToolDeps, principal: Principal, extra?: ResolvedChannel): Promise<FormatContext> {
  const channelNames = await deps.channels.nameMap();
  if (extra && "name" in extra && extra.name) channelNames.set(extra.id, extra.name);
  return {
    guildId: deps.guildId,
    channelNames,
    roleNames: new Map(principal.access.guild.roles.map((role) => [role.id, role.name])),
  };
}

export function describeThread(thread: APIThreadChannel, parentNames: ReadonlyMap<string, string>): string {
  const meta = thread.thread_metadata;
  const parts = [
    THREAD_LABELS.get(thread.type) ?? "thread",
    meta?.archived ? "archived" : "active",
    thread.parent_id ? `in #${parentNames.get(thread.parent_id) ?? thread.parent_id}` : undefined,
    typeof thread.message_count === "number" ? `${thread.message_count} messages` : undefined,
    meta?.create_timestamp ? `created ${formatTimestamp(meta.create_timestamp)}` : undefined,
    meta?.archived && meta.archive_timestamp ? `archived ${formatTimestamp(meta.archive_timestamp)}` : undefined,
  ].filter(Boolean);
  return `- ${thread.name} (id ${thread.id}; ${parts.join(", ")})`;
}

export function byPosition(a: GuildChannel, b: GuildChannel): number {
  return (a.position ?? 0) - (b.position ?? 0) || compareSnowflakes(a.id, b.id);
}
