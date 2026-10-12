import { TtlCache, systemClock, type Clock } from "../lib/ttl-cache";
import type { GuildInfo, MemberInfo } from "./types";

/** Minimal Discord surface needed for authorization decisions. */
export interface GuildDirectory {
  fetchGuild(): Promise<GuildInfo>;
  /** Returns null when the user is not a member of the guild. */
  fetchMember(userId: string): Promise<MemberInfo | null>;
}

const DIRECTORY_TTL_MS = 60_000;

export class CachedGuildDirectory implements GuildDirectory {
  private readonly guildCache: TtlCache<"guild", GuildInfo>;
  private readonly memberCache: TtlCache<string, MemberInfo | null>;

  constructor(
    private readonly source: GuildDirectory,
    options: { ttlMs?: number; clock?: Clock } = {},
  ) {
    const ttl = options.ttlMs ?? DIRECTORY_TTL_MS;
    const clock = options.clock ?? systemClock;
    this.guildCache = new TtlCache(ttl, clock);
    this.memberCache = new TtlCache(ttl, clock);
  }

  fetchGuild(): Promise<GuildInfo> {
    return this.guildCache.getOrLoad("guild", () => this.source.fetchGuild());
  }

  fetchMember(userId: string): Promise<MemberInfo | null> {
    return this.memberCache.getOrLoad(userId, () => this.source.fetchMember(userId));
  }
}
