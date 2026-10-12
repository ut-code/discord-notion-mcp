import type { APIMessage } from "discord-api-types/v10";
import { compareSnowflakes } from "../lib/snowflake";
import type { MessageQuery } from "./api";

const DISCORD_PAGE_SIZE = 100;

export interface HistoryRequest {
  limit: number;
  before?: string;
  after?: string;
}

type FetchPage = (query: MessageQuery) => Promise<APIMessage[]>;

const ascending = (a: APIMessage, b: APIMessage) => compareSnowflakes(a.id, b.id);

/**
 * Collects up to `limit` messages, paginating by Discord's 100-message page size.
 * With only `after`, walks forward from that point; otherwise walks backward from
 * `before` (or the latest message), stopping at `after` when both are given.
 * Always returns messages oldest first.
 */
export async function fetchHistory(fetchPage: FetchPage, request: HistoryRequest): Promise<APIMessage[]> {
  const collected: APIMessage[] = [];

  if (request.after && !request.before) {
    let cursor = request.after;
    while (collected.length < request.limit) {
      const requested = Math.min(DISCORD_PAGE_SIZE, request.limit - collected.length);
      const page = [...(await fetchPage({ after: cursor, limit: requested }))].sort(ascending);
      collected.push(...page);
      const last = page.at(-1);
      if (!last || page.length < requested) break;
      cursor = last.id;
    }
    return collected.slice(0, request.limit).sort(ascending);
  }

  let cursor = request.before;
  pages: while (collected.length < request.limit) {
    const requested = Math.min(DISCORD_PAGE_SIZE, request.limit - collected.length);
    const page = [...(await fetchPage({ before: cursor, limit: requested }))].sort((a, b) => ascending(b, a));
    for (const message of page) {
      if (request.after && compareSnowflakes(message.id, request.after) <= 0) break pages;
      collected.push(message);
    }
    const oldest = page.at(-1);
    if (!oldest || page.length < requested) break;
    cursor = oldest.id;
  }
  return collected.slice(0, request.limit).sort(ascending);
}
