import type { LoginUser } from "../auth/users";
import { PERMISSIONS, type Permission } from "../authz/permissions";
import { isGuildAdmin, type EffectiveAccess } from "../authz/resolver";
import type { GrantRow } from "../db/schema";
import type { GuildInfo, RoleInfo } from "../discord/types";
import { displayName } from "../lib/display-name";
import { administratorRoles, heldRoles, type UserSubject } from "./subjects";

/** Why an individual grant has no effect: a role of the user, or admin status, already provides it. */
export type Redundancy = { kind: "role"; role: RoleInfo } | { kind: "admin" };

export type GrantRowView =
  | { kind: "admin-role"; permission: "admin"; role: RoleInfo }
  | { kind: "owner"; permission: "admin"; user: UserSubject }
  | {
      kind: "grant";
      permission: Permission;
      grant: GrantRow;
      role: RoleInfo | null;
      user: UserSubject | null;
      createdBy: UserSubject | null;
      redundancy: Redundancy | null;
    };

const permissionIndex = (permission: Permission) => PERMISSIONS.indexOf(permission);

function subjectName(row: Extract<GrantRowView, { kind: "grant" }>): string {
  return row.role?.name ?? row.user?.displayName ?? row.grant.subjectId;
}

function redundancyOf(guild: GuildInfo, grants: readonly GrantRow[], grant: GrantRow, user: UserSubject | null): Redundancy | null {
  const member = user?.member;
  if (grant.subjectType !== "user" || !member) return null;
  if (isGuildAdmin(guild, member)) return { kind: "admin" };
  const roleIds = new Set([guild.id, ...member.roles]);
  const providing = new Set(
    grants
      .filter((other) => other.subjectType === "role" && roleIds.has(other.subjectId))
      .filter((other) => other.permission === grant.permission || other.permission === "admin")
      .map((other) => other.subjectId),
  );
  const role = guild.roles.filter((candidate) => providing.has(candidate.id)).sort((a, b) => b.position - a.position)[0];
  if (role) return { kind: "role", role };
  const individualAdmin = grants.some((other) => other.subjectType === "user" && other.subjectId === grant.subjectId && other.permission === "admin");
  return grant.permission !== "admin" && individualAdmin ? { kind: "admin" } : null;
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
        createdBy: grant.createdBy ? (users.get(grant.createdBy) ?? null) : null,
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

export type MembershipState = "member" | "not_member" | "unlinked" | "unknown";

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
export function buildUserRow(user: LoginUser, access: EffectiveAccess | Error | null, guild: GuildInfo, grants: readonly GrantRow[]): UserRowView {
  const base = { user, displayName: user.name, username: null, avatarUrl: null, roles: [], permissions: [], isAdmin: false, implicitAdmin: false, individual: [] };
  if (access === null) return { ...base, membership: "unlinked" };
  if (access instanceof Error) return { ...base, membership: "unknown" };
  if (!access.isMember) return { ...base, membership: "not_member" };

  const member = access.member;
  const implicitAdmin = isGuildAdmin(guild, member);
  const roleIds = new Set([guild.id, ...member.roles]);
  const fromRoles = new Set(grants.filter((g) => g.subjectType === "role" && roleIds.has(g.subjectId)).map((g) => g.permission));
  const fromUser = new Set(grants.filter((g) => g.subjectType === "user" && g.subjectId === member.userId).map((g) => g.permission));
  const held = access.isAdmin ? (["admin"] as Permission[]) : PERMISSIONS.filter((permission) => access.permissions.has(permission));
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
    individual: implicitAdmin ? [] : held.filter((permission) => fromUser.has(permission) && !fromRoles.has(permission)),
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
