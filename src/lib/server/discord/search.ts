import {
  ChannelType,
  type APIMessage,
  type APIMessageSearchResult,
  type APIThreadChannel,
  type RESTGetAPIGuildMessagesSearchQuery,
} from "discord-api-types/v10";
import { createLimiter } from "../lib/limiter";
import type { ChannelAccess, ChannelDirectory, Viewer } from "./access";
import { isThread, THREAD_CHECK_CONCURRENCY } from "./access";
import type { DiscordApi } from "./api";
import { canReadMessages } from "./permissions";

/** Discord rejects more channel_id filters than this. */
const MAX_SEARCH_CHANNELS = 500;
/** Discord rejects a larger offset. */
export const MAX_SEARCH_OFFSET = 9975;
const MAX_INDEX_ATTEMPTS = 3;
const MAX_INDEX_WAIT_SECONDS = 5;

export type SearchMessage = Omit<APIMessage, "reactions">;

export interface SearchScope {
  /** Channel filter sent to Discord; undefined searches the whole guild. */
  channelIds?: string[];
  /**
   * Discord leaves age-restricted (NSFW) channels out of search unless asked. Only a search
   * of one named age-restricted channel includes them; a search across channels never does.
   */
  includeNsfw: boolean;
}

export type SearchOutcome =
  | {
      status: "ok";
      messages: SearchMessage[];
      /** Threads the returned messages belong to (never ones the viewer cannot read). */
      threads: APIThreadChannel[];
      /**
       * Discord's total, or null when it may count messages the viewer cannot read: a
       * guild-wide search, or a page from which unreadable results were dropped.
       */
      readableTotal: number | null;
    }
  | { status: "indexing"; retryAfterSeconds: number };

export interface SearchDeps {
  api: DiscordApi;
  access: ChannelAccess;
  channels: ChannelDirectory;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Restricts the search to what the viewer can read (channels and visible threads are
 * listed explicitly). When the viewer can read every channel, or the list is too long,
 * the guild-wide search is used: results are still filtered and no total is reported.
 */
export async function buildSearchScope(deps: SearchDeps, viewer: Viewer, channelId?: string): Promise<SearchScope> {
  if (channelId) {
    const { channel } = await deps.access.resolveReadable(channelId, viewer);
    return { channelIds: [channel.id], includeNsfw: "nsfw" in channel && channel.nsfw === true };
  }

  const messageChannels = (await deps.channels.list()).filter((channel) => channel.type !== ChannelType.GuildCategory);
  const readable = messageChannels.filter((channel) => canReadMessages(deps.access.permissionsFor(channel, viewer)));
  if (readable.length === messageChannels.length) return { includeNsfw: false };

  // Archived threads are left out: Discord lists them per channel and per page only.
  const visibleThreads = await deps.access.filterVisibleThreads(await deps.api.fetchActiveThreads(), viewer, true);
  const channelIds = [...readable.map((channel) => channel.id), ...visibleThreads.map((thread) => thread.id)];
  if (channelIds.length > MAX_SEARCH_CHANNELS) return { includeNsfw: false };
  return { channelIds, includeNsfw: false };
}

/** Drops results from channels or threads the viewer cannot read, and the threads of dropped results. */
async function filterReadableResults(
  deps: SearchDeps,
  viewer: Viewer,
  result: APIMessageSearchResult,
): Promise<{ messages: SearchMessage[]; threads: APIThreadChannel[] }> {
  const channelsById = new Map((await deps.channels.list()).map((channel) => [channel.id, channel]));
  const threadsById = new Map((result.threads ?? []).map((thread) => [thread.id, thread]));

  const canRead = async (channelId: string): Promise<boolean> => {
    const listed = channelsById.get(channelId);
    if (listed) return canReadMessages(deps.access.permissionsFor(listed, viewer));
    const fetched = threadsById.get(channelId) ?? (await deps.access.fetchUnlisted(channelId));
    return fetched !== null && isThread(fetched) && (await deps.access.isThreadVisible(fetched, viewer, true));
  };

  // Each channel is judged once, the ones that may ask Discord a few at a time.
  const all = result.messages.flat();
  const channelIds = [...new Set(all.map((message) => message.channel_id))];
  const limit = createLimiter(THREAD_CHECK_CONCURRENCY);
  const verdicts = await Promise.all(channelIds.map((channelId) => limit(() => canRead(channelId))));
  const readable = new Set(channelIds.filter((_, index) => verdicts[index]));
  const messages: SearchMessage[] = all.filter((message) => readable.has(message.channel_id));
  return { messages, threads: [...threadsById.values()].filter((thread) => readable.has(thread.id)) };
}

/** Runs the search, waiting briefly while Discord builds the guild's search index. */
export async function searchReadableMessages(
  deps: SearchDeps,
  viewer: Viewer,
  query: RESTGetAPIGuildMessagesSearchQuery,
): Promise<SearchOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    const response = await deps.api.searchMessages(query);
    if (response.status === "ok") {
      const { messages, threads } = await filterReadableResults(deps, viewer, response.result);
      const dropped = response.result.messages.flat().length - messages.length;
      const scoped = query.channel_id !== undefined;
      return {
        status: "ok",
        messages,
        threads,
        readableTotal: scoped && dropped === 0 ? response.result.total_results : null,
      };
    }
    if (attempt >= MAX_INDEX_ATTEMPTS) return response;
    await sleep(Math.min(Math.max(response.retryAfterSeconds, 0.5), MAX_INDEX_WAIT_SECONDS) * 1000);
  }
}
