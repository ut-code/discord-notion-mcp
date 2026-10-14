import { ADMINISTRATOR, computeBasePermissions, hasPermission } from "../discord/permissions";
import type { GuildInfo, MemberInfo } from "../discord/types";
import type { GuildDirectory } from "../discord/directory";
import type { GrantLookup } from "./grants";
import { PERMISSIONS, type Permission } from "./permissions";

/**
 * What a Discord user may do. Admins hold every permission, so callers check
 * `permissions.has(...)` alone and never special-case `isAdmin` for a permission.
 */
export type EffectiveAccess =
  | { isMember: false; discordUserId: string; guild: GuildInfo; permissions: ReadonlySet<Permission>; isAdmin: false }
  | {
      isMember: true;
      discordUserId: string;
      guild: GuildInfo;
      member: MemberInfo;
      permissions: ReadonlySet<Permission>;
      isAdmin: boolean;
    };

export class PermissionResolver {
  constructor(
    private readonly directory: GuildDirectory,
    private readonly grants: GrantLookup,
  ) {}

  async resolve(discordUserId: string): Promise<EffectiveAccess> {
    const [guild, member] = await Promise.all([this.directory.fetchGuild(), this.directory.fetchMember(discordUserId)]);
    if (!member) {
      return { isMember: false, discordUserId, guild, permissions: new Set(), isAdmin: false };
    }
    if (isGuildAdmin(guild, member)) {
      return { isMember: true, discordUserId, guild, member, permissions: new Set(PERMISSIONS), isAdmin: true };
    }
    const roleIds = [...new Set([guild.id, ...member.roles])];
    const granted = await this.grants.permissionsFor(discordUserId, roleIds);
    if (granted.has("admin")) {
      return { isMember: true, discordUserId, guild, member, permissions: new Set(PERMISSIONS), isAdmin: true };
    }
    return { isMember: true, discordUserId, guild, member, permissions: granted, isAdmin: false };
  }
}

/** Guild owner, or any held role (including @everyone) carrying ADMINISTRATOR. */
export function isGuildAdmin(guild: GuildInfo, member: MemberInfo): boolean {
  if (member.userId === guild.ownerId) return true;
  return hasPermission(computeBasePermissions(guild, member), ADMINISTRATOR);
}
