// Shared types, constants and helpers used by the Discord tool modules.
import { DiscordAPIError, HTTPError, RateLimitError } from "@discordjs/rest";
import { ChannelType, GuildScheduledEventStatus, MessageSearchHasType, type APIThreadChannel } from "discord-api-types/v10";
import { z } from "zod";
import { ToolError } from "../../lib/errors";
import { INSTANT_EXAMPLE } from "../../lib/instant";
import { parseMessageCursor } from "../../lib/snowflake";
import type { Principal, ToolResult } from "../../mcp/registry";
import { NotAccessibleError, type ChannelAccess, type ChannelDirectory, type ResolvedChannel, type Viewer } from "../access";
import type { DiscordApi } from "../api";
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

const THREAD_LABELS = new Map<ChannelType, string>([
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

/**
 * Maps Discord API errors to tool errors: "not found / forbidden" to the uniform not-accessible
 * one, a rate limit too long to wait out to when to retry, and outages (5xx or a timeout,
 * after @discordjs/rest's own retries) to "retry later", which is safe because every Discord
 * tool only reads.
 */
export function withDiscordErrors<A>(handler: (args: A, principal: Principal) => Promise<ToolResult>) {
  return async (args: A, ctx: { principal: Principal }): Promise<ToolResult> => {
    try {
      return await handler(args, ctx.principal);
    } catch (error) {
      if (error instanceof DiscordAPIError && (error.status === 403 || error.status === 404)) {
        throw new NotAccessibleError("Not found or not accessible.");
      }
      if (error instanceof DiscordAPIError && error.status === 400) {
        // Without a JSON body (an HTML page from Discord's edge) there is no code or message.
        throw new ToolError(error.code === undefined ? "Discord rejected the request." : `Discord rejected the request: ${error.message}`, {
          logMessage: `Discord rejected the request (400 ${error.code === undefined ? "without a JSON body" : String(error.code)})`,
        });
      }
      if (error instanceof RateLimitError) {
        throw new ToolError(`Discord rate limit reached; retry in about ${Math.ceil(error.retryAfter / 1000)} s.`);
      }
      const outage =
        error instanceof HTTPError ? `HTTP ${error.status}` : error instanceof Error && error.name === "AbortError" ? "timed out" : null;
      if (outage) throw new ToolError(`Discord is not responding (${outage}); please retry in a moment.`);
      throw error;
    }
  };
}

/** A `before` / `after` argument, read with parseCursor. */
export function cursorSchema(field: "before" | "after") {
  return z
    .string()
    .optional()
    .describe(`Only messages ${field} this message id or ISO 8601 datetime with time zone, e.g. ${INSTANT_EXAMPLE}`);
}

export function parseCursor(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    return parseMessageCursor(value);
  } catch {
    throw new ToolError(`Invalid "${field}": expected a message id or an ISO 8601 datetime with a time zone, e.g. ${INSTANT_EXAMPLE}.`);
  }
}

export function channelLabel(channel: ResolvedChannel): string {
  const name = "name" in channel && channel.name ? channel.name : channel.id;
  return `#${name}`;
}

export async function formatContextFor(deps: DiscordToolDeps, principal: Principal, extra?: ResolvedChannel): Promise<FormatContext> {
  // Only channels the viewer can see are named: a mention of another channel stays an id,
  // so a message in a shared channel does not reveal what a hidden channel is called.
  const visible = await deps.access.listVisibleChannels(viewerOf(principal));
  const channelNames = new Map(visible.map(({ channel }) => [channel.id, channel.name ?? channel.id]));
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
