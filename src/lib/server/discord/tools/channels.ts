// Discord tools for listing channels and threads.
import { ChannelType } from "discord-api-types/v10";
import { z } from "zod";
import { ToolError } from "../../lib/errors";
import { INSTANT_EXAMPLE, parseInstant } from "../../lib/instant";
import { snowflakeSchema } from "../../lib/snowflake";
import { defineTool, READ_ONLY_ANNOTATIONS, type AnyToolDefinition } from "../../mcp/registry";
import { BOT_NO_ACCESS_MESSAGE, byPosition, LISTED_CHANNEL_TYPES, NotAccessibleError } from "../access";
import type { GuildChannel } from "../api";
import { canReadMessages, canViewChannel } from "../permissions";
import { describeThread, viewerOf, withDiscordErrors, type DiscordToolDeps } from "./shared";

/** Also accepts the archive timestamps Discord returns, e.g. "2026-10-01T12:34:56.789000+00:00". */
function parseArchiveTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const instant = parseInstant(value);
  if (!instant) throw new ToolError(`Invalid "before": expected an ISO 8601 datetime with a time zone, e.g. ${INSTANT_EXAMPLE}.`);
  return instant.toString({ smallestUnit: "millisecond" });
}

export function createChannelTools(deps: DiscordToolDeps): { listChannels: AnyToolDefinition; listThreads: AnyToolDefinition } {
  const listChannels = defineTool({
    name: "discord_list_channels",
    title: "List Discord channels",
    description:
      "List the Discord channels you can view (text, announcement, forum, media, voice and stage channels), grouped by category, with id, type and topic. Channels the server's MCP bot cannot read are marked: they cannot be read or searched here.",
    permission: "discord:read",
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withDiscordErrors(async (_args: Record<string, never>, principal) => {
      const viewer = viewerOf(principal);
      const botPermissions = await deps.access.botPermissions(viewer.guild);
      const all = await deps.channels.list();
      const categories = new Map(
        all.filter((channel) => channel.type === ChannelType.GuildCategory).map((channel) => [channel.id, channel]),
      );
      const visible = (await deps.access.listVisibleChannels(viewer))
        .map((entry) => entry.channel)
        .filter((channel) => LISTED_CHANNEL_TYPES.has(channel.type))
        .sort(byPosition);

      if (visible.length === 0) return "No channels are visible to you.";

      const groups = new Map<GuildChannel | null, GuildChannel[]>();
      for (const channel of visible) {
        const category = channel.parent_id ? (categories.get(channel.parent_id) ?? null) : null;
        groups.set(category, [...(groups.get(category) ?? []), channel]);
      }
      const orderedCategories = [...groups.keys()].sort((a, b) => {
        if (a === null) return -1;
        if (b === null) return 1;
        return byPosition(a, b);
      });

      const lines = [`Server: ${principal.access.guild.name}`, ""];
      for (const category of orderedCategories) {
        lines.push(category === null ? "(no category)" : `Category: ${category.name ?? category.id}`);
        for (const channel of groups.get(category) ?? []) {
          const topic = channel.topic ? ` — ${channel.topic.replace(/\s+/g, " ")}` : "";
          const unreadable = canReadMessages(botPermissions(channel)) ? "" : ", not readable here: the MCP bot cannot read it";
          lines.push(`  #${channel.name} (id ${channel.id}, ${LISTED_CHANNEL_TYPES.get(channel.type)}${unreadable})${topic}`);
        }
        lines.push("");
      }
      return lines.join("\n").trimEnd();
    }),
  });

  const listThreads = defineTool({
    name: "discord_list_threads",
    title: "List Discord threads",
    description:
      "List threads you can view. Without channel_id: all active threads in the server. With channel_id: active threads of that channel plus its archived public threads (paginate archived threads with `before`).",
    permission: "discord:read",
    inputSchema: z.object({
      channel_id: snowflakeSchema.optional().describe("Parent channel (text, announcement, forum or media) to list threads for"),
      limit: z.number().int().min(1).max(100).default(50).describe("Max archived threads to return (only with channel_id)"),
      before: z
        .string()
        .optional()
        .describe(
          `ISO 8601 datetime with time zone, e.g. ${INSTANT_EXAMPLE}; return threads archived before this time (only with channel_id)`,
        ),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withDiscordErrors(async (args, principal) => {
      const viewer = viewerOf(principal);
      const parentNames = await deps.channels.nameMap();
      const active = await deps.api.fetchActiveThreads();

      if (!args.channel_id) {
        const visible = await deps.access.filterVisibleThreads(active, viewer);
        if (visible.length === 0) return "No active threads are visible to you.";
        return [`Active threads (${visible.length}):`, ...visible.map((t) => describeThread(t, parentNames))].join("\n");
      }

      const parent = await deps.channels.find(args.channel_id);
      const permissions = parent ? deps.access.permissionsFor(parent, viewer) : 0n;
      if (!parent || !canViewChannel(permissions)) throw new NotAccessibleError();
      const botPermissions = (await deps.access.botPermissions(viewer.guild))(parent);
      if (!canViewChannel(botPermissions)) throw new ToolError(BOT_NO_ACCESS_MESSAGE);

      const before = parseArchiveTimestamp(args.before);

      const activeVisible = await deps.access.filterVisibleThreads(
        active.filter((thread) => thread.parent_id === parent.id),
        viewer,
      );
      const lines = [`Threads in #${parent.name} (id ${parent.id})`, "", `Active (${activeVisible.length}):`];
      lines.push(...(activeVisible.length ? activeVisible.map((t) => describeThread(t, parentNames)) : ["  (none)"]));
      // Discord lists archived threads only to those who can read the channel's history.
      if (!canReadMessages(permissions)) {
        lines.push("", "Archived public: not listed (you cannot read this channel's message history).");
        return lines.join("\n");
      }
      if (!canReadMessages(botPermissions)) {
        lines.push("", "Archived public: not listed (the server's MCP bot cannot read this channel's message history).");
        return lines.join("\n");
      }
      const archived = await deps.api.fetchArchivedPublicThreads(parent.id, { before, limit: args.limit });
      const archivedVisible = await deps.access.filterVisibleThreads(archived.threads, viewer);
      lines.push("", `Archived public (${archivedVisible.length}):`);
      lines.push(...(archivedVisible.length ? archivedVisible.map((t) => describeThread(t, parentNames)) : ["  (none)"]));
      const oldest = archived.threads.at(-1)?.thread_metadata?.archive_timestamp;
      if (archived.hasMore && oldest) lines.push("", `More archived threads exist. Call again with before="${oldest}".`);
      return lines.join("\n");
    }),
  });

  return { listChannels, listThreads };
}
