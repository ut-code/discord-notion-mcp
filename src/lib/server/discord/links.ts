import { isSnowflake } from "../lib/snowflake";

export interface MessageRef {
  guildId: string;
  channelId: string;
  messageId: string;
}

export type MessageLinkResult = { ok: true; ref: MessageRef } | { ok: false; error: string };

const ALLOWED_HOSTS = new Set([
  "discord.com",
  "www.discord.com",
  "ptb.discord.com",
  "canary.discord.com",
  "discordapp.com",
  "www.discordapp.com",
  "ptb.discordapp.com",
  "canary.discordapp.com",
]);

export function parseMessageLink(link: string, expectedGuildId: string): MessageLinkResult {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return { ok: false, error: "Malformed message link." };
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    return { ok: false, error: "Not a Discord message link." };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "channels") {
    return { ok: false, error: "Malformed message link: expected https://discord.com/channels/{guild}/{channel}/{message}." };
  }
  const [, guildId, channelId, messageId] = segments as [string, string, string, string];
  if (guildId === "@me") {
    return { ok: false, error: "Direct message links are not supported." };
  }
  if (!isSnowflake(guildId) || !isSnowflake(channelId) || !isSnowflake(messageId)) {
    return { ok: false, error: "Malformed message link: ids must be numeric." };
  }
  if (guildId !== expectedGuildId) {
    return { ok: false, error: "This link points to a different Discord server, which this MCP server does not serve." };
  }
  return { ok: true, ref: { guildId, channelId, messageId } };
}

export function buildMessageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
