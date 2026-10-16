import { namesMatch, searchNeedle } from "../../name-match";
import type { DiscordApi } from "../discord/api";
import { isSnowflake } from "../lib/snowflake";
import { systemClock, TtlCache, type Clock } from "../lib/ttl-cache";
import { subjectFromMember, type SubjectResolver, type UserSubject } from "./subjects";

const PAGE_SIZE = 1000;
/** Larger guilds are listed in part; their searches also ask Discord, which matches name prefixes only. */
const MAX_PAGES = 10;
const CACHE_TTL_MS = 60_000;

export interface Roster {
  /** Members other than bots, by display name. */
  members: UserSubject[];
  /** False when the guild has more members than were listed. */
  complete: boolean;
}

const byName = new Intl.Collator("ja");

function matches(user: UserSubject, needle: string): boolean {
  return namesMatch([user.displayName, user.username, user.member?.nick, user.member?.globalName], needle);
}

/**
 * The guild's members for the grant form: listed once a minute at most (concurrent loads
 * share one), searched in memory by any part of a name. A Discord id resolves directly.
 */
export class MemberRoster {
  private readonly cache: TtlCache<"roster", Roster>;

  constructor(
    private readonly discord: Pick<DiscordApi, "listMembers" | "searchMembers">,
    private readonly subjects: Pick<SubjectResolver, "resolveUser">,
    clock: Clock = systemClock,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, clock);
  }

  /** Failures are thrown and not cached. */
  roster(): Promise<Roster> {
    return this.cache.getOrLoad("roster", () => this.load());
  }

  /** Members whose names contain the query, up to `limit`. */
  async search(query: string, limit: number): Promise<UserSubject[]> {
    const needle = searchNeedle(query);
    if (!needle) return [];
    if (isSnowflake(needle)) {
      const subject = await this.subjects.resolveUser(needle);
      return subject.displayName ? [subject] : [];
    }
    const roster = await this.roster();
    const found = roster.members.filter((user) => matches(user, needle)).slice(0, limit);
    if (roster.complete || found.length >= limit) return found;
    const listed = new Set(found.map((user) => user.id));
    const prefixed = (await this.discord.searchMembers(needle, limit)).filter((member) => !listed.has(member.userId));
    return [...found, ...prefixed.map(subjectFromMember)].slice(0, limit);
  }

  private async load(): Promise<Roster> {
    const members: UserSubject[] = [];
    let after: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_PAGES && !complete; page++) {
      const batch = await this.discord.listMembers(PAGE_SIZE, after);
      for (const member of batch) if (!member.bot) members.push(subjectFromMember(member));
      after = batch.at(-1)?.userId;
      complete = batch.length < PAGE_SIZE;
    }
    members.sort((a, b) => byName.compare(a.displayName ?? "", b.displayName ?? ""));
    return { members, complete };
  }
}
