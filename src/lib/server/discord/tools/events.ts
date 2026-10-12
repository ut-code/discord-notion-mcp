// Discord tool for listing scheduled events.
import { GuildScheduledEventEntityType } from "discord-api-types/v10";
import { z } from "zod";
import { defineTool, READ_ONLY_ANNOTATIONS, type AnyToolDefinition } from "../../mcp/registry";
import { formatTimestamp } from "../format";
import { canViewChannel } from "../permissions";
import { EVENT_STATUS, viewerOf, withDiscordErrors, type DiscordToolDeps } from "./shared";

export function createEventTools(deps: DiscordToolDeps): { listEvents: AnyToolDefinition } {
  const listEvents = defineTool({
    name: "discord_list_events",
    title: "List Discord scheduled events",
    description: "List the server's scheduled events (name, description, start/end, location or channel, status).",
    permission: "discord:read",
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withDiscordErrors(async (_args: Record<string, never>, principal) => {
      const viewer = viewerOf(principal);
      const [events, channels] = await Promise.all([deps.api.fetchScheduledEvents(), deps.channels.list()]);
      const channelById = new Map(channels.map((channel) => [channel.id, channel]));
      const visible = events.filter((event) => {
        if (!event.channel_id) return true;
        const channel = channelById.get(event.channel_id);
        return channel ? canViewChannel(deps.access.permissionsFor(channel, viewer)) : false;
      });
      if (visible.length === 0) return "No scheduled events are visible to you.";
      visible.sort((a, b) => a.scheduled_start_time.localeCompare(b.scheduled_start_time));
      const blocks = visible.map((event) => {
        const location =
          event.entity_type === GuildScheduledEventEntityType.External
            ? (event.entity_metadata?.location ?? "external")
            : event.channel_id
              ? `#${channelById.get(event.channel_id)?.name ?? event.channel_id}`
              : "unknown";
        const lines = [
          `- ${event.name} (id ${event.id}) [${EVENT_STATUS.get(event.status) ?? `status ${event.status}`}]`,
          `  start: ${formatTimestamp(event.scheduled_start_time)}${event.scheduled_end_time ? ` | end: ${formatTimestamp(event.scheduled_end_time)}` : ""}`,
          `  location: ${location}`,
        ];
        if (event.description) lines.push(`  description: ${event.description.replace(/\s+/g, " ")}`);
        return lines.join("\n");
      });
      return [`Scheduled events (${visible.length}):`, ...blocks].join("\n");
    }),
  });

  return { listEvents };
}
