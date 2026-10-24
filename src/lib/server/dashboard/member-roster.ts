import { compareNames } from "../../locale";
import type { DiscordApi } from "../discord/api";
import { errorMessage } from "../lib/errors";
import { logError, type ErrorSink } from "../lib/log";
import { systemClock, type Clock } from "../lib/ttl-cache";
import { subjectFromMember, type UserSubject } from "./subjects";

const PAGE_SIZE = 1000;
/** Larger guilds are listed in part; their lookups and searches also ask Discord about the rest. */
const MAX_PAGES = 10;
/** How long a list is used as it is; an older one is still shown while a new one loads. */
const FRESH_MS = 60_000;
/** Once a load has failed, how old a list may still be shown; past it callers wait for Discord (and see its error). */
const STALE_AFTER_FAILURE_MS = 10 * 60_000;

export interface Roster {
  /** Members other than bots, by display name. */
  members: UserSubject[];
  /** Every listed member by user id, bots included. */
  byId: ReadonlyMap<string, UserSubject>;
  /**
   * False when members may be missing: the guild has more than were listed, or the list is
   * older than a minute (someone may have joined since).
   */
  complete: boolean;
}

/**
 * The guild's members for the dashboard's names, avatars, searches and role badges (access
 * decisions ask Discord separately). One request per thousand members gives every name, avatar
 * and role, instead of one per member. Listing takes a second or more, so once a list is older
 * than a minute the old one is returned at once while a new one loads (concurrent loads share one).
 * After a failed load the old list is shown for a few minutes more (a passing failure goes unseen);
 * then callers wait for the next load, so a Discord outage shows as an error instead of an ever older list.
 */
export class MemberRoster {
  private current: { roster: Roster; loadedAt: number } | null = null;
  private inflight: Promise<Roster> | null = null;
  private lastLoadFailed = false;
  private readonly clock: Clock;
  private readonly logFailure: ErrorSink;

  constructor(
    private readonly discord: Pick<DiscordApi, "listMembers">,
    options: { clock?: Clock; logError?: ErrorSink } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.logFailure = options.logError ?? logError;
  }

  /** Throws when listing fails while there is no list yet, or while loads keep failing past STALE_AFTER_FAILURE_MS. */
  roster(): Promise<Roster> {
    const current = this.current;
    const age = current ? this.clock() - current.loadedAt : Number.POSITIVE_INFINITY;
    if (current && age < FRESH_MS) return Promise.resolve(current.roster);
    if (!current || (this.lastLoadFailed && age >= STALE_AFTER_FAILURE_MS)) return this.refresh();
    if (!this.inflight) {
      this.refresh().catch((error: unknown) => {
        this.logFailure({ event: "admin_lookup_failed", lookup: "member_list", error: errorMessage(error) });
      });
    }
    return Promise.resolve({ ...current.roster, complete: false });
  }

  private refresh(): Promise<Roster> {
    this.inflight ??= this.load()
      .then(
        (roster) => {
          this.current = { roster, loadedAt: this.clock() };
          this.lastLoadFailed = false;
          return roster;
        },
        (error: unknown) => {
          this.lastLoadFailed = true;
          throw error;
        },
      )
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
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
