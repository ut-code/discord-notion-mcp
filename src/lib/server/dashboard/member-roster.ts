import { compareNames } from "../../locale";
import type { DiscordApi } from "../discord/api";
import { systemClock, TtlCache, type Clock } from "../lib/ttl-cache";
import { subjectFromMember, type UserSubject } from "./subjects";

const PAGE_SIZE = 1000;
/** Larger guilds are listed in part; their lookups and searches also ask Discord about the rest. */
const MAX_PAGES = 10;
const CACHE_TTL_MS = 60_000;

export interface Roster {
  /** Members other than bots, by display name. */
  members: UserSubject[];
  /** Every listed member by user id, bots included. */
  byId: ReadonlyMap<string, UserSubject>;
  /** False when the guild has more members than were listed. */
  complete: boolean;
}

/**
 * The guild's members, listed once a minute at most (concurrent loads share one): one request per
 * thousand members gives the pages every name, avatar and role they show, instead of one per member.
 */
export class MemberRoster {
  private readonly cache: TtlCache<"roster", Roster>;

  constructor(
    private readonly discord: Pick<DiscordApi, "listMembers">,
    clock: Clock = systemClock,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, clock);
  }

  /** Failures are thrown and not cached. */
  roster(): Promise<Roster> {
    return this.cache.getOrLoad("roster", () => this.load());
  }

  private async load(): Promise<Roster> {
    const members: UserSubject[] = [];
    const byId = new Map<string, UserSubject>();
    let after: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_PAGES && !complete; page++) {
      const batch = await this.discord.listMembers(PAGE_SIZE, after);
      for (const member of batch) {
        const subject = subjectFromMember(member);
        byId.set(subject.id, subject);
        if (!member.bot) members.push(subject);
      }
      after = batch.at(-1)?.userId;
      complete = batch.length < PAGE_SIZE;
    }
    members.sort((a, b) => compareNames(a.displayName ?? "", b.displayName ?? ""));
    return { members, byId, complete };
  }
}
