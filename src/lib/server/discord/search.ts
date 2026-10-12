import {
  ChannelType,
  type APIMessage,
  type APIMessageSearchResult,
  type APIThreadChannel,
  type RESTGetAPIGuildMessagesSearchQuery,
} from "discord-api-types/v10";
import type { ChannelAccess, ChannelDirectory, Viewer } from "./access";
import { isThread } from "./access";
import type { DiscordApi } from "./api";
import { canReadMessages } from "./permissions";

/** Discord rejects more channel_id filters than this. */
const MAX_SEARCH_CHANNELS = 500;
const MAX_INDEX_ATTEMPTS = 3;
const MAX_INDEX_WAIT_SECONDS = 5;

export type SearchMessage = Omit<APIMessage, "reactions">;

export interface SearchScope {
  /** Channel filter sent to Discord; undefined searches the whole guild. */
  channelIds?: string[];
  includeNsfw: boolean;
}

export type SearchOutcome =
  | { status: "ok"; messages: SearchMessage[]; threads: APIThreadChannel[]; totalResults: number; droppedCount: number }
  | { status: "indexing"; retryAfterSeconds: number };

export interface SearchDeps {
  api: DiscordApi;
  access: ChannelAccess;
  channels: ChannelDirectory;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Restricts the search to what the viewer can read. When the viewer can read every
 * channel, the guild-wide search is used (results are still filtered afterwards).
 */
export async function buildSearchScope(deps: SearchDeps, viewer: Viewer, channelId?: string): Promise<SearchScope> {
  if (channelId) {
    const { channel } = await deps.access.resolveReadable(channelId, viewer);
    return { channelIds: [channel.id], includeNsfw: "nsfw" in channel && channel.nsfw === true };
  }

  const messageChannels = (await deps.channels.list()).filter((channel) => channel.type !== ChannelType.GuildCategory);
  const readable = messageChannels.filter((channel) => canReadMessages(deps.access.permissionsFor(channel, viewer)));
  if (readable.length === messageChannels.length) return { includeNsfw: false };

  const threads = await deps.api.fetchActiveThreads();
  const visibleThreads: APIThreadChannel[] = [];
  for (const thread of threads) {
    if (await deps.access.isThreadVisible(thread, viewer, true)) visibleThreads.push(thread);
  }
  const channelIds = [...readable.map((channel) => channel.id), ...visibleThreads.map((thread) => thread.id)];
  if (channelIds.length > MAX_SEARCH_CHANNELS) return { includeNsfw: false };
  return { channelIds, includeNsfw: false };
}

/** Drops results from channels or threads the viewer cannot read. */
async function filterReadableResults(
  deps: SearchDeps,
  viewer: Viewer,
  result: APIMessageSearchResult,
): Promise<SearchMessage[]> {
  const channelsById = new Map((await deps.channels.list()).map((channel) => [channel.id, channel]));
  const threadsById = new Map((result.threads ?? []).map((thread) => [thread.id, thread]));
  const verdicts = new Map<string, boolean>();

  const canRead = async (channelId: string): Promise<boolean> => {
    const cached = verdicts.get(channelId);
    if (cached !== undefined) return cached;
    let verdict = false;
    const listed = channelsById.get(channelId);
    if (listed) {
      verdict = canReadMessages(deps.access.permissionsFor(listed, viewer));
    } else {
      const fetched = threadsById.get(channelId) ?? (await deps.api.fetchChannel(channelId));
      verdict = fetched !== null && isThread(fetched) && (await deps.access.isThreadVisible(fetched, viewer, true));
    }
    verdicts.set(channelId, verdict);
    return verdict;
  };

  const readable: SearchMessage[] = [];
  for (const message of result.messages.flat()) {
    if (await canRead(message.channel_id)) readable.push(message);
  }
  return readable;
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
      const messages = await filterReadableResults(deps, viewer, response.result);
      return {
        status: "ok",
        messages,
        threads: response.result.threads ?? [],
        totalResults: response.result.total_results,
        droppedCount: response.result.messages.flat().length - messages.length,
      };
    }
    if (attempt >= MAX_INDEX_ATTEMPTS) return response;
    await sleep(Math.min(Math.max(response.retryAfterSeconds, 0.5), MAX_INDEX_WAIT_SECONDS) * 1000);
  }
}
