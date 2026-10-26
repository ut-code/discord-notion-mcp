import { ChannelType } from "discord-api-types/v10";
import { m } from "../../paraglide/messages.js";
import { byPosition, type ChannelReach } from "../discord/access";
import type { GuildChannel } from "../discord/api";
import { errorMessage } from "../lib/errors";
import type { Viewer } from "./access";
import type { DashboardDeps } from "./deps";

interface ChannelView {
  id: string;
  name: string;
  /** Opens the channel in Discord. */
  href: string;
  /** False when the bot was not given the channel: the viewer's MCP clients cannot read it. */
  botCanRead: boolean;
}

interface CategoryView {
  /** The category's id, or "" for channels outside any. */
  id: string;
  /** Null for channels outside any category, listed first as in Discord. */
  name: string | null;
  channels: ChannelView[];
}

interface ChannelsView {
  /** The channels the viewer may read, by category. */
  categories: CategoryView[];
  /** Of those, the ones the bot may read too. */
  accessibleCount: number;
  botlessCount: number;
}

export type ChannelsSection = { kind: "channels"; view: ChannelsView } | { kind: "error"; message: string } | null;

function byCategory(reach: ChannelReach[], categories: Map<string, GuildChannel>, guildId: string): CategoryView[] {
  const groups = new Map<GuildChannel | null, ChannelReach[]>();
  for (const entry of reach) {
    const category = entry.channel.parent_id ? (categories.get(entry.channel.parent_id) ?? null) : null;
    groups.set(category, [...(groups.get(category) ?? []), entry]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : byPosition(a, b)))
    .map(([category, entries]) => ({
      id: category?.id ?? "",
      name: category ? (category.name ?? category.id) : null,
      channels: entries
        .sort((a, b) => byPosition(a.channel, b.channel))
        .map(({ channel, botCanRead }) => ({
          id: channel.id,
          name: channel.name ?? channel.id,
          href: `https://discord.com/channels/${guildId}/${channel.id}`,
          botCanRead,
        })),
    }));
}

/** The Discord channels the viewer may read, and which of them their MCP clients can; null without the Discord permission. */
export async function channelsSection(
  deps: Pick<DashboardDeps, "directory" | "channelAccess" | "channels" | "logError">,
  viewer: Pick<Viewer, "discordUserId" | "permissions">,
): Promise<ChannelsSection> {
  if (!viewer.permissions.includes("discord:read")) return null;
  try {
    const [guild, member] = await Promise.all([deps.directory.fetchGuild(), deps.directory.fetchMember(viewer.discordUserId)]);
    // The dashboard let the viewer in as a member a moment ago: a miss now is a failed lookup.
    if (!member) throw new Error("the viewer is not a member");
    const [reach, all] = await Promise.all([deps.channelAccess.readableChannels({ guild, member }), deps.channels.list()]);
    const categories = new Map(all.filter((channel) => channel.type === ChannelType.GuildCategory).map((channel) => [channel.id, channel]));
    const accessibleCount = reach.filter((entry) => entry.botCanRead).length;
    return {
      kind: "channels",
      view: { categories: byCategory(reach, categories, guild.id), accessibleCount, botlessCount: reach.length - accessibleCount },
    };
  } catch (error) {
    deps.logError({ event: "channel_list_failed", error: errorMessage(error) });
    return { kind: "error", message: m.tools_channels_failed() };
  }
}
