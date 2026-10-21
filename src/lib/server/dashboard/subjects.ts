import type { GuildDirectory } from "../discord/directory";
import { namesMatch, searchNeedle } from "../../name-match";
import type { DiscordApi } from "../discord/api";
import { ADMINISTRATOR, hasPermission } from "../discord/permissions";
import type { GuildInfo, MemberInfo, RoleInfo } from "../discord/types";
import { displayName } from "../lib/display-name";
import { errorMessage } from "../lib/errors";
import { createLimiter } from "../lib/limiter";
import { logError, type ErrorSink } from "../lib/log";
import { isSnowflake } from "../lib/snowflake";
import type { MemberRoster, Roster } from "./member-roster";

export interface UserSubject {
  id: string;
  /** Null when the user could not be resolved. */
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  /** Set when the user is a member of the guild. */
  member: MemberInfo | null;
}

export function subjectFromMember(member: MemberInfo): UserSubject {
  return { id: member.userId, displayName: displayName(member), username: member.username, avatarUrl: member.avatarUrl, member };
}

/** Roles that can be granted permissions: highest first, @everyone last, integration roles excluded. */
export function grantableRoles(guild: GuildInfo): RoleInfo[] {
  return guild.roles.filter((role) => !role.managed).sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
}

/** Roles whose members are admins without any grant (ADMINISTRATOR), highest first. */
export function administratorRoles(guild: GuildInfo): RoleInfo[] {
  return guild.roles.filter((role) => hasPermission(role.permissions, ADMINISTRATOR)).sort((a, b) => b.position - a.position);
}

/** The roles a member holds, highest first, without @everyone. */
export function heldRoles(guild: GuildInfo, member: MemberInfo | null): RoleInfo[] {
  if (!member) return [];
  const held = new Set(member.roles);
  return guild.roles.filter((role) => held.has(role.id) && role.id !== guild.id).sort((a, b) => b.position - a.position);
}

function matches(user: UserSubject, needle: string): boolean {
  return namesMatch([user.displayName, user.username, user.member?.nick, user.member?.globalName], needle);
}

/**
 * Resolves Discord user ids to names and avatars for the dashboard. Several at once are looked
 * up in the member list (one request per thousand members); one at a time, and anyone not on the
 * list (who left, or joined since it was loaded), through the cached directory.
 */
export class SubjectResolver {
  private readonly limit = createLimiter(4);

  constructor(
    private readonly directory: GuildDirectory,
    private readonly discord: Pick<DiscordApi, "fetchUser" | "searchMembers">,
    private readonly members: Pick<MemberRoster, "roster">,
    private readonly logFailure: ErrorSink = logError,
  ) {}

  async resolveUser(id: string): Promise<UserSubject> {
    try {
      const member = await this.directory.fetchMember(id);
      if (member) return subjectFromMember(member);
      const user = await this.discord.fetchUser(id);
      if (user) return { id, displayName: displayName(user), username: user.username, avatarUrl: user.avatarUrl, member: null };
    } catch (error) {
      this.logFailure({ event: "admin_lookup_failed", lookup: "user", userId: id, error: errorMessage(error) });
    }
    return { id, displayName: null, username: null, avatarUrl: null, member: null };
  }

  async resolveUsers(ids: Iterable<string>): Promise<Map<string, UserSubject>> {
    const unique = [...new Set(ids)];
    const roster = unique.length > 0 ? await this.listed() : null;
    const resolved = await Promise.all(unique.map(async (id) => roster?.byId.get(id) ?? this.limit(() => this.resolveUser(id))));
    return new Map(resolved.map((subject) => [subject.id, subject]));
  }

  /** Avatars of guild members only (no user fetches); failures are left out. */
  async memberAvatars(ids: Iterable<string>): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const roster = unique.length > 0 ? await this.listed() : null;
    const avatars = new Map<string, string>();
    await Promise.all(
      unique.map(async (id) => {
        const listed = roster?.byId.get(id);
        if (listed) {
          if (listed.avatarUrl) avatars.set(id, listed.avatarUrl);
          return;
        }
        await this.limit(async () => {
          try {
            const member = await this.directory.fetchMember(id);
            if (member?.avatarUrl) avatars.set(id, member.avatarUrl);
          } catch (error) {
            // An avatar is decoration: the row shows initials instead.
            this.logFailure({ event: "admin_lookup_failed", lookup: "avatar", userId: id, error: errorMessage(error) });
          }
        });
      }),
    );
    return avatars;
  }

  /** Members whose names contain the query, up to `limit`; a Discord id resolves directly. Failures are thrown. */
  async search(query: string, limit: number): Promise<UserSubject[]> {
    const needle = searchNeedle(query);
    if (!needle) return [];
    if (isSnowflake(needle)) {
      const subject = await this.resolveUser(needle);
      return subject.displayName ? [subject] : [];
    }
    const roster = await this.members.roster();
    const found = roster.members.filter((user) => matches(user, needle)).slice(0, limit);
    if (roster.complete || found.length >= limit) return found;
    // Discord's own search matches name prefixes only.
    const listed = new Set(found.map((user) => user.id));
    const prefixed = (await this.discord.searchMembers(needle, limit)).filter((member) => !listed.has(member.userId));
    return [...found, ...prefixed.map(subjectFromMember)].slice(0, limit);
  }

  /** The member list, or null when it cannot be loaded (lookups then go one by one). */
  private async listed(): Promise<Roster | null> {
    try {
      return await this.members.roster();
    } catch (error) {
      this.logFailure({ event: "admin_lookup_failed", lookup: "member_list", error: errorMessage(error) });
      return null;
    }
  }
}
