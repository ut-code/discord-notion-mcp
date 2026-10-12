// Discord tools for listing channels and threads.
import { ChannelType } from "discord-api-types/v10";
import { z } from "zod";
import { ToolError } from "../../lib/errors";
import { snowflakeSchema } from "../../lib/snowflake";
import { defineTool, READ_ONLY_ANNOTATIONS, type AnyToolDefinition } from "../../mcp/registry";
import { NotAccessibleError } from "../access";
import type { GuildChannel } from "../api";
import { canViewChannel } from "../permissions";
import { byPosition, describeThread, LISTED_CHANNEL_TYPES, viewerOf, withDiscordErrors, type DiscordToolDeps } from "./shared";

export function createChannelTools(deps: DiscordToolDeps): { listChannels: AnyToolDefinition; listThreads: AnyToolDefinition } {
  const listChannels = defineTool({
    name: "discord_list_channels",
    title: "List Discord channels",
    description:
      "List the Discord channels you can view (text, announcement, forum, media, voice and stage channels), grouped by category, with id, type and topic.",
    permission: "discord:read",
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withDiscordErrors(async (_args: Record<string, never>, principal) => {
      const viewer = viewerOf(principal);
      const all = await deps.channels.list();
      const categories = new Map(
        all.filter((channel) => channel.type === ChannelType.GuildCategory).map((channel) => [channel.id, channel]),
      );
      const visible = (await deps.access.listVisibleChannels(viewer))
        .map((entry) => entry.channel)
        .filter((channel) => LISTED_CHANNEL_TYPES.has(channel.type))
        .sort(byPosition);

      if (visible.length === 0) return "No channels are visible to you.";

      const groups = new Map<string | null, GuildChannel[]>();
      for (const channel of visible) {
        const key = channel.parent_id && categories.has(channel.parent_id) ? channel.parent_id : null;
        groups.set(key, [...(groups.get(key) ?? []), channel]);
      }
      const orderedKeys = [...groups.keys()].sort((a, b) => {
        if (a === null) return -1;
        if (b === null) return 1;
        return byPosition(categories.get(a)!, categories.get(b)!);
      });

      const lines = [`Server: ${principal.access.guild.name}`, ""];
      for (const key of orderedKeys) {
        lines.push(key === null ? "(no category)" : `Category: ${categories.get(key)?.name ?? key}`);
        for (const channel of groups.get(key) ?? []) {
          const topic = channel.topic ? ` — ${channel.topic.replace(/\s+/g, " ")}` : "";
          lines.push(`  #${channel.name} (id ${channel.id}, ${LISTED_CHANNEL_TYPES.get(channel.type)})${topic}`);
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
        .describe("ISO 8601 timestamp; return archived threads archived before this time (only with channel_id)"),
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
      if (!parent || !canViewChannel(deps.access.permissionsFor(parent, viewer))) throw new NotAccessibleError();

      let before: string | undefined;
      if (args.before !== undefined) {
        const date = new Date(args.before);
        if (Number.isNaN(date.getTime())) throw new ToolError('Invalid "before": expected an ISO 8601 timestamp.');
        before = date.toISOString();
      }

      const activeVisible = await deps.access.filterVisibleThreads(
        active.filter((thread) => thread.parent_id === parent.id),
        viewer,
      );
      const archived = await deps.api.fetchArchivedPublicThreads(parent.id, { before, limit: args.limit });
      const archivedVisible = await deps.access.filterVisibleThreads(archived.threads, viewer);

      const lines = [`Threads in #${parent.name} (id ${parent.id})`, "", `Active (${activeVisible.length}):`];
      lines.push(...(activeVisible.length ? activeVisible.map((t) => describeThread(t, parentNames)) : ["  (none)"]));
      lines.push("", `Archived public (${archivedVisible.length}):`);
      lines.push(...(archivedVisible.length ? archivedVisible.map((t) => describeThread(t, parentNames)) : ["  (none)"]));
      const oldest = archived.threads.at(-1)?.thread_metadata?.archive_timestamp;
      if (archived.hasMore && oldest) lines.push("", `More archived threads exist. Call again with before="${oldest}".`);
      return lines.join("\n");
    }),
  });

  return { listChannels, listThreads };
}
