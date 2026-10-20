/**
 * How long Discord lookups behind access decisions are reused: the guild and its roles, a
 * member's roles, the channel list, threads and private thread membership. It is also the
 * longest a permission change (a role removed, a channel or thread closed) takes to apply,
 * so it is fixed from the fetch and never extended on use.
 */
export const DISCORD_CACHE_TTL_MS = 60_000;

/**
 * Per-id caches (members, threads, thread membership) drop their oldest entries past this
 * many: an expired entry is only replaced when loaded again, so ids looked up once would otherwise stay.
 */
export const MAX_CACHED_PER_ID = 5_000;
