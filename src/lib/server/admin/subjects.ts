import type { GuildDirectory } from "../discord/directory";
import type { DiscordApi } from "../discord/api";
import { ADMINISTRATOR, hasPermission } from "../discord/permissions";
import type { GuildInfo, MemberInfo, RoleInfo } from "../discord/types";
import { displayName } from "../lib/display-name";
import { errorMessage } from "../lib/errors";
import { createLimiter } from "../lib/limiter";
import { logError, type ErrorSink } from "../lib/log";

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

/** Resolves Discord user ids to names and avatars for the admin UI, through the cached directory. */
export class SubjectResolver {
  private readonly limit = createLimiter(4);

  constructor(
    private readonly directory: GuildDirectory,
    private readonly discord: Pick<DiscordApi, "fetchUser">,
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
    const resolved = await Promise.all(unique.map((id) => this.limit(() => this.resolveUser(id))));
    return new Map(resolved.map((subject) => [subject.id, subject]));
  }

  /** Avatars of guild members only (cached lookups, no user fetches); failures are left out. */
  async memberAvatars(ids: Iterable<string>): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const avatars = new Map<string, string>();
    await Promise.all(
      unique.map((id) =>
        this.limit(async () => {
          const member = await this.directory.fetchMember(id).catch(() => null);
          if (member?.avatarUrl) avatars.set(id, member.avatarUrl);
        }),
      ),
    );
    return avatars;
  }
}
