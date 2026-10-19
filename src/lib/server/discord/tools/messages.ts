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
import { channelLabel, cursorSchema, formatContextFor, parseCursor, viewerOf, withDiscordErrors, type DiscordToolDeps } from "./shared";

/** Pins are listed in pages of PIN_PAGE_SIZE, up to MAX_PINS per call. */
const PIN_PAGE_SIZE = 50;
const MAX_PINS = 150;

export function createMessageTools(deps: DiscordToolDeps): {
  readMessages: AnyToolDefinition;
  getMessage: AnyToolDefinition;
  listPins: AnyToolDefinition;
} {
  const readMessages = defineTool({
    name: "discord_read_messages",
    title: "Read Discord messages",
    description:
      "Read messages from a channel or thread you can access, returned oldest first. `before`/`after` accept a message id or an ISO 8601 datetime with time zone. Without cursors, returns the latest messages.",
    permission: "discord:read",
    inputSchema: z.object({
      channel_id: snowflakeSchema.describe("Channel or thread id"),
      limit: z.number().int().min(1).max(200).default(50).describe("Number of messages (1-200)"),
      before: cursorSchema("before"),
      after: cursorSchema("after"),
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
      const first = messages[0];
      const last = messages.at(-1);
      if (first === undefined || last === undefined) return `${header}\n\nNo messages found for this range.`;
      const ctx = await formatContextFor(deps, principal, channel);
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
      // One request for the message and its context; Discord does not document whether
      // `around` includes the message itself, so it is fetched on its own when missing.
      const nearby = await deps.api.fetchMessages(channel.id, { around: messageId, limit: args.context * 2 + 1 });
      const target = nearby.find((message) => message.id === messageId) ?? (await deps.api.fetchMessage(channel.id, messageId));
      if (!target) throw new NotAccessibleError("Message not found or not accessible.");

      const older = nearby.filter((message) => compareSnowflakes(message.id, messageId) < 0).sort((a, b) => compareSnowflakes(a.id, b.id));
      const newer = nearby.filter((message) => compareSnowflakes(message.id, messageId) > 0).sort((a, b) => compareSnowflakes(a.id, b.id));
      const messages = [...older.slice(Math.max(0, older.length - args.context)), target, ...newer.slice(0, args.context)];
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
      while (messages.length < MAX_PINS) {
        const result = await deps.api.fetchPins(channel.id, { before, limit: Math.min(PIN_PAGE_SIZE, MAX_PINS - messages.length) });
        messages.push(...result.messages);
        hasMore = result.hasMore;
        if (!result.hasMore || !result.nextBefore) break;
        before = result.nextBefore;
      }
      if (messages.length === 0) return `${channelLabel(channel)} (id ${channel.id}) has no pinned messages.`;
      const ctx = await formatContextFor(deps, principal, channel);
      const header = `${channelLabel(channel)} (id ${channel.id}) — ${messages.length} pinned message(s), most recently pinned first`;
      const footer = hasMore ? `\n\n(More pins exist; only the most recent ${messages.length} are shown.)` : "";
      return `${header}\n\n${formatMessages(messages, ctx)}${footer}`;
    }),
  });

  return { readMessages, getMessage, listPins };
}
