// Discord tool for searching messages.
import {
  MessageSearchAuthorType,
  MessageSearchSortMode,
  type MessageSearchHasType,
  type RESTGetAPIGuildMessagesSearchQuery,
} from "discord-api-types/v10";
import { z } from "zod";
import { ToolError } from "../../lib/errors";
import { compareSnowflakes, snowflakeSchema } from "../../lib/snowflake";
import { defineTool, READ_ONLY_ANNOTATIONS, type AnyToolDefinition } from "../../mcp/registry";
import { formatMessage } from "../format";
import { buildSearchScope, searchReadableMessages } from "../search";
import { formatContextFor, parseCursor, SEARCH_HAS_TYPES, viewerOf, withDiscordErrors, type DiscordToolDeps } from "./shared";

export function createSearchTools(deps: DiscordToolDeps): { searchMessages: AnyToolDefinition } {
  const searchMessages = defineTool({
    name: "discord_search_messages",
    title: "Search Discord messages",
    description:
      "Search messages in channels and threads you can read (Discord server search). Combine `query` with filters; newest first by default, page with `offset`. Archived threads are only searched when passed as channel_id. Open a result's link with discord_get_message for surrounding context.",
    permission: "discord:read",
    inputSchema: z.object({
      query: z.string().min(1).max(1024).optional().describe("Words to search for in message content"),
      channel_id: snowflakeSchema.optional().describe("Limit to one channel or thread"),
      author_id: snowflakeSchema.optional().describe("Only messages by this user id"),
      mentions_user_id: snowflakeSchema.optional().describe("Only messages mentioning this user id"),
      has: z.array(z.enum(SEARCH_HAS_TYPES)).max(SEARCH_HAS_TYPES.length).optional().describe("Only messages containing all of these"),
      pinned: z.boolean().optional().describe("Only pinned (true) or unpinned (false) messages"),
      exclude_bots: z.boolean().default(false).describe("Exclude messages from bots and webhooks"),
      before: z.string().optional().describe("Only messages before this message id or ISO 8601 datetime"),
      after: z.string().optional().describe("Only messages after this message id or ISO 8601 datetime"),
      sort: z.enum(["newest", "oldest", "relevance"]).default("newest"),
      limit: z.number().int().min(1).max(25).default(25).describe("Results per page (1-25)"),
      offset: z.number().int().min(0).max(9975).default(0).describe("Number of results to skip"),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withDiscordErrors(async (args, principal) => {
      const before = parseCursor(args.before, "before");
      const after = parseCursor(args.after, "after");
      if (before && after && compareSnowflakes(before, after) <= 0) {
        throw new ToolError('"before" must be later than "after".');
      }
      const viewer = viewerOf(principal);
      const searchDeps = { api: deps.api, access: deps.access, channels: deps.channels, sleep: deps.sleep };
      const scope = await buildSearchScope(searchDeps, viewer, args.channel_id);
      const query: RESTGetAPIGuildMessagesSearchQuery = {
        content: args.query,
        channel_id: scope.channelIds,
        author_id: args.author_id ? [args.author_id] : undefined,
        mentions: args.mentions_user_id ? [args.mentions_user_id] : undefined,
        has: args.has as MessageSearchHasType[] | undefined,
        pinned: args.pinned,
        author_type: args.exclude_bots ? [MessageSearchAuthorType.User] : undefined,
        max_id: before,
        min_id: after,
        sort_by: args.sort === "relevance" ? MessageSearchSortMode.Relevance : MessageSearchSortMode.Timestamp,
        sort_order: args.sort === "oldest" ? "asc" : "desc",
        include_nsfw: scope.includeNsfw || undefined,
        limit: args.limit,
        offset: args.offset,
      };

      const outcome = await searchReadableMessages(searchDeps, viewer, query);
      if (outcome.status === "indexing") {
        return `Discord is still building the search index for this server. Try again in about ${Math.ceil(outcome.retryAfterSeconds)} seconds.`;
      }

      const ctx = await formatContextFor(deps, principal);
      const names = new Map(ctx.channelNames);
      for (const thread of outcome.threads) if (thread.name) names.set(thread.id, thread.name);

      const total = outcome.readableTotal;
      const header = `Search results — ${outcome.messages.length} shown (offset ${args.offset}${total !== null ? `, ${total} total` : ""})`;
      const nextOffset = args.offset + args.limit;
      // Without a trustworthy total only a full page of readable results suggests another page.
      const hasMore = total !== null ? nextOffset < total : outcome.messages.length === args.limit;
      const more = hasMore && nextOffset <= 9975 ? `\nMore: offset=${nextOffset}` : "";
      if (outcome.messages.length === 0) return `${header}${more}\n\nNo messages found.`;
      const blocks = outcome.messages.map(
        (message) => `#${names.get(message.channel_id) ?? message.channel_id}\n${formatMessage(message, ctx)}`,
      );
      return `${header}${more}\n\n${blocks.join("\n\n")}`;
    }),
  });

  return { searchMessages };
}
