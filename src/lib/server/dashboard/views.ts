import type { LoginUser } from "../auth/users";
import { givesPermission, PERMISSIONS, type Permission } from "../permissions/permissions";
import { isGuildAdmin, type EffectiveAccess } from "../permissions/resolver";
import type { GrantRow } from "../db/schema";
import type { GrantKey } from "../permissions/grants";
import type { GuildInfo, RoleInfo } from "../discord/types";
import { displayName } from "../lib/display-name";
import { administratorRoles, heldRoles, type UserSubject } from "./subjects";

/** Why a grant has no effect: a role the user holds, their admin status, or a broader grant to the same subject provides it. */
export type Redundancy = { kind: "role"; role: RoleInfo } | { kind: "admin" } | { kind: "included"; by: Permission };

export type GrantRowView =
  | { kind: "admin-role"; permission: "admin"; role: RoleInfo }
  | { kind: "owner"; permission: "admin"; user: UserSubject }
  | {
      kind: "grant";
      permission: Permission;
      grant: GrantRow;
      role: RoleInfo | null;
      user: UserSubject | null;
      redundancy: Redundancy | null;
    };

const permissionIndex = (permission: Permission) => PERMISSIONS.indexOf(permission);

function subjectName(row: Extract<GrantRowView, { kind: "grant" }>): string {
  return row.role?.name ?? row.user?.displayName ?? row.grant.subjectId;
}

/** For an existing grant or one about to be made; `user` is the subject of a user grant. */
export function redundancyOf(guild: GuildInfo, grants: readonly GrantRow[], grant: GrantKey, user: UserSubject | null): Redundancy | null {
  const member = grant.subjectType === "user" ? user?.member : undefined;
  if (member) {
    if (isGuildAdmin(guild, member)) return { kind: "admin" };
    const roleIds = new Set([guild.id, ...member.roles]);
    const providing = new Set(
      grants
        .filter((other) => other.subjectType === "role" && roleIds.has(other.subjectId))
        .filter((other) => givesPermission(other.permission, grant.permission))
        .map((other) => other.subjectId),
    );
    const role = guild.roles.filter((candidate) => providing.has(candidate.id)).sort((a, b) => b.position - a.position)[0];
    if (role) return { kind: "role", role };
  }
  const broader = grants.find(
    (other) =>
      other.subjectType === grant.subjectType &&
      other.subjectId === grant.subjectId &&
      other.permission !== grant.permission &&
      givesPermission(other.permission, grant.permission),
  );
  if (!broader) return null;
  return broader.permission === "admin" ? { kind: "admin" } : { kind: "included", by: broader.permission };
}

/** Implicit admins (ADMINISTRATOR roles, the owner) first, then grants: roles before users, by permission and name. */
export function buildGrantRows(
  guild: GuildInfo,
  grants: readonly GrantRow[],
  users: ReadonlyMap<string, UserSubject>,
  owner: UserSubject,
): GrantRowView[] {
  const roleById = new Map(guild.roles.map((role) => [role.id, role]));
  const explicit = grants
    .map((grant): Extract<GrantRowView, { kind: "grant" }> => {
      const user = grant.subjectType === "user" ? (users.get(grant.subjectId) ?? null) : null;
      return {
        kind: "grant",
        permission: grant.permission,
        grant,
        role: grant.subjectType === "role" ? (roleById.get(grant.subjectId) ?? null) : null,
        user,
        redundancy: redundancyOf(guild, grants, grant, user),
      };
    })
    .sort(
      (a, b) =>
        Number(a.grant.subjectType === "user") - Number(b.grant.subjectType === "user") ||
        permissionIndex(a.permission) - permissionIndex(b.permission) ||
        subjectName(a).localeCompare(subjectName(b), "ja"),
    );
  return [
    ...administratorRoles(guild).map((role): GrantRowView => ({ kind: "admin-role", permission: "admin", role })),
    { kind: "owner", permission: "admin", user: owner },
    ...explicit,
  ];
}

type MembershipState = "member" | "not_member" | "unlinked" | "unknown";

export interface UserRowView {
  user: LoginUser;
  membership: MembershipState;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  roles: RoleInfo[];
  /** Effective permissions without "admin"; empty for admins (shown as a single badge). */
  permissions: Permission[];
  isAdmin: boolean;
  /** Owner or ADMINISTRATOR role: admin without any grant. */
  implicitAdmin: boolean;
  /** Permissions held only through a grant to the user (not through a role or implicit admin). */
  individual: Permission[];
}

/** `access` is null when the Discord account is not linked, an Error when it could not be resolved. */
export function buildUserRow(
  user: LoginUser,
  access: EffectiveAccess | Error | null,
  guild: GuildInfo,
  grants: readonly GrantRow[],
): UserRowView {
  const base = {
    user,
    displayName: user.name,
    username: null,
    avatarUrl: null,
    roles: [],
    permissions: [],
    isAdmin: false,
    implicitAdmin: false,
    individual: [],
  };
  if (access === null) return { ...base, membership: "unlinked" };
  if (access instanceof Error) return { ...base, membership: "unknown" };
  if (!access.isMember) return { ...base, membership: "not_member" };

  const member = access.member;
  const implicitAdmin = isGuildAdmin(guild, member);
  const roleIds = new Set([guild.id, ...member.roles]);
  const fromRoles = new Set(grants.filter((g) => g.subjectType === "role" && roleIds.has(g.subjectId)).map((g) => g.permission));
  const fromUser = new Set(grants.filter((g) => g.subjectType === "user" && g.subjectId === member.userId).map((g) => g.permission));
  const held: Permission[] = access.isAdmin ? ["admin"] : PERMISSIONS.filter((permission) => access.permissions.has(permission));
  return {
    user,
    membership: "member",
    displayName: displayName(member),
    username: member.username,
    avatarUrl: member.avatarUrl,
    roles: heldRoles(guild, member),
    permissions: access.isAdmin ? [] : held,
    isAdmin: access.isAdmin,
    implicitAdmin,
    // A grant to the user that a role grant already gives (a role's Notion write gives read) is not individual.
    individual: implicitAdmin
      ? []
      : held.filter((permission) => fromUser.has(permission) && ![...fromRoles].some((fromRole) => givesPermission(fromRole, permission))),
  };
}

/** Case-insensitive match on display name, @username, login name and ids. */
export function matchesUserQuery(row: UserRowView, query: string): boolean {
  const needle = query.trim().replace(/^@/, "").toLowerCase();
  if (!needle) return true;
  return [row.displayName, row.username, row.user.name, row.user.discordUserId, row.user.userId].some((value) =>
    value?.toLowerCase().includes(needle),
  );
}
