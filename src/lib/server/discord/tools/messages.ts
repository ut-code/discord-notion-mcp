// Discord tools for reading messages and pins.
import type { APIMessage } from "discord-api-types/v10";
import { z } from "zod";
import { ToolError } from "../../lib/errors";
import { compareSnowflakes, snowflakeSchema } from "../../lib/snowflake";
import { defineTool, READ_ONLY_ANNOTATIONS, type AnyToolDefinition } from "../../mcp/registry";
import { NotAccessibleError } from "../access";
import { formatMessages } from "../format";
import { fetchHistory } from "../history";
import { parseMessageLink } from "../links";
import { channelLabel, formatContextFor, parseCursor, viewerOf, withDiscordErrors, type DiscordToolDeps } from "./shared";

export function createMessageTools(deps: DiscordToolDeps): {
  readMessages: AnyToolDefinition;
  getMessage: AnyToolDefinition;
  listPins: AnyToolDefinition;
} {
  const readMessages = defineTool({
    name: "discord_read_messages",
    title: "Read Discord messages",
    description:
      "Read messages from a channel or thread you can access, returned oldest first. `before`/`after` accept a message id or an ISO 8601 datetime. Without cursors, returns the latest messages.",
    permission: "discord:read",
    inputSchema: z.object({
      channel_id: snowflakeSchema.describe("Channel or thread id"),
      limit: z.number().int().min(1).max(200).default(50).describe("Number of messages (1-200)"),
      before: z.string().optional().describe("Only messages before this message id or ISO 8601 datetime"),
      after: z.string().optional().describe("Only messages after this message id or ISO 8601 datetime"),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withDiscordErrors(async (args, principal) => {
      const before = parseCursor(args.before, "before");
      const after = parseCursor(args.after, "after");
      if (before && after && compareSnowflakes(before, after) <= 0) {
        throw new ToolError('"before" must be later than "after".');
      }
      const { channel } = await deps.access.resolveReadable(args.channel_id, viewerOf(principal));
      const messages = await fetchHistory((query) => deps.api.fetchMessages(channel.id, query), {
        limit: args.limit,
        before,
        after,
      });
      const header = `${channelLabel(channel)} (id ${channel.id}) — ${messages.length} message(s), oldest first`;
      if (messages.length === 0) return `${header}\n\nNo messages found for this range.`;
      const ctx = await formatContextFor(deps, principal, channel);
      const first = messages[0]!;
      const last = messages.at(-1)!;
      const hints = [`Older: before="${first.id}"`, after || before ? `Newer: after="${last.id}"` : undefined].filter(Boolean);
      return `${header}\n${hints.join(" | ")}\n\n${formatMessages(messages, ctx)}`;
    }),
  });

  const getMessage = defineTool({
    name: "discord_get_message",
    title: "Get a Discord message",
    description:
      "Get one message by link (https://discord.com/channels/{guild}/{channel}/{message}) or by channel_id + message_id, with surrounding context messages.",
    permission: "discord:read",
    inputSchema: z.object({
      message_link: z.string().optional().describe("Discord message link"),
      channel_id: snowflakeSchema.optional().describe("Channel or thread id (with message_id)"),
      message_id: snowflakeSchema.optional().describe("Message id (with channel_id)"),
      context: z.number().int().min(0).max(20).default(5).describe("Messages to include before and after (0-20)"),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withDiscordErrors(async (args, principal) => {
      let channelId: string;
      let messageId: string;
      if (args.message_link) {
        const parsed = parseMessageLink(args.message_link, deps.guildId);
        if (!parsed.ok) throw new ToolError(parsed.error);
        channelId = parsed.ref.channelId;
        messageId = parsed.ref.messageId;
      } else if (args.channel_id && args.message_id) {
        channelId = args.channel_id;
        messageId = args.message_id;
      } else {
        throw new ToolError("Provide either message_link, or both channel_id and message_id.");
      }

      const { channel } = await deps.access.resolveReadable(channelId, viewerOf(principal));
      const target = await deps.api.fetchMessage(channel.id, messageId);
      if (!target) throw new NotAccessibleError("Message not found or not accessible.");

      const [older, newer] =
        args.context > 0
          ? await Promise.all([
              deps.api.fetchMessages(channel.id, { before: messageId, limit: args.context }),
              deps.api.fetchMessages(channel.id, { after: messageId, limit: args.context }),
            ])
          : [[], []];
      const messages = [...older, target, ...newer].sort((a, b) => compareSnowflakes(a.id, b.id));
      const ctx = await formatContextFor(deps, principal, channel);
      return `${channelLabel(channel)} (id ${channel.id}) — message ${messageId} marked with ▶\n\n${formatMessages(messages, ctx, messageId)}`;
    }),
  });

  const listPins = defineTool({
    name: "discord_list_pins",
    title: "List pinned Discord messages",
    description: "List pinned messages of a channel or thread you can access (most recently pinned first).",
    permission: "discord:read",
    inputSchema: z.object({
      channel_id: snowflakeSchema.describe("Channel or thread id"),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withDiscordErrors(async (args, principal) => {
      const { channel } = await deps.access.resolveReadable(args.channel_id, viewerOf(principal));
      const messages: APIMessage[] = [];
      let before: string | undefined;
      let hasMore = false;
      for (let page = 0; page < 3; page++) {
        const result = await deps.api.fetchPins(channel.id, { before, limit: 50 });
        messages.push(...result.messages);
        hasMore = result.hasMore;
        if (!result.hasMore || !result.nextBefore) break;
        before = result.nextBefore;
      }
      if (messages.length === 0) return `${channelLabel(channel)} (id ${channel.id}) has no pinned messages.`;
      const ctx = await formatContextFor(deps, principal, channel);
      const header = `${channelLabel(channel)} (id ${channel.id}) — ${messages.length} pinned message(s), most recently pinned first`;
      const footer = hasMore ? "\n\n(More pins exist; only the most recent 150 are shown.)" : "";
      return `${header}\n\n${formatMessages(messages, ctx)}${footer}`;
    }),
  });

  return { readMessages, getMessage, listPins };
}
