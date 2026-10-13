import type { DiscordApi } from "../discord/api";
import { isSnowflake } from "../lib/snowflake";
import { systemClock, TtlCache, type Clock } from "../lib/ttl-cache";
import { subjectFromMember, type SubjectResolver, type UserSubject } from "./subjects";

const MEMBER_SEARCH_LIMIT = 10;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 200;

/** Cache key and Discord query: Discord matches names case-insensitively. */
function normalizeMemberQuery(query: string): string {
  return query.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Member lookup for the grant form. A Discord id resolves directly, anything else is a
 * name prefix. Results are cached briefly per normalized query so bursts of typing reuse
 * one Discord request; failures are thrown and not cached.
 */
export class MemberSearch {
  private readonly cache: TtlCache<string, UserSubject[]>;

  constructor(
    private readonly discord: Pick<DiscordApi, "searchMembers">,
    private readonly subjects: Pick<SubjectResolver, "resolveUser">,
    clock: Clock = systemClock,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, clock, CACHE_MAX_ENTRIES);
  }

  search(query: string): Promise<UserSubject[]> {
    const needle = normalizeMemberQuery(query);
    if (!needle) return Promise.resolve([]);
    return this.cache.getOrLoad(needle, async () => {
      if (isSnowflake(needle)) {
        const subject = await this.subjects.resolveUser(needle);
        return subject.displayName ? [subject] : [];
      }
      return (await this.discord.searchMembers(needle, MEMBER_SEARCH_LIMIT)).map(subjectFromMember);
    });
  }
}
