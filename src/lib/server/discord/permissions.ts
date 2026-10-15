import { OverwriteType, PermissionFlagsBits, type APIOverwrite } from "discord-api-types/v10";
import type { GuildInfo, MemberInfo, PermissionOverwrite } from "./types";

export const ADMINISTRATOR = PermissionFlagsBits.Administrator;
export const VIEW_CHANNEL = PermissionFlagsBits.ViewChannel;
export const READ_MESSAGE_HISTORY = PermissionFlagsBits.ReadMessageHistory;
export const MANAGE_THREADS = PermissionFlagsBits.ManageThreads;

export const ALL_PERMISSIONS: bigint = Object.values(PermissionFlagsBits).reduce((acc, bit) => acc | bit, 0n);

/** True when every bit of `flag` is set. */
export function hasPermission(permissions: bigint, flag: bigint): boolean {
  return (permissions & flag) === flag;
}

export function canViewChannel(permissions: bigint): boolean {
  return hasPermission(permissions, VIEW_CHANNEL);
}

export function canReadMessages(permissions: bigint): boolean {
  return hasPermission(permissions, VIEW_CHANNEL | READ_MESSAGE_HISTORY);
}

export function toOverwrite(raw: APIOverwrite): PermissionOverwrite {
  return {
    id: raw.id,
    type: raw.type,
    allow: BigInt(raw.allow),
    deny: BigInt(raw.deny),
  };
}

export function isGuildOwner(guild: GuildInfo, member: MemberInfo): boolean {
  return member.userId === guild.ownerId;
}

/** Guild-level permissions: @everyone role OR member roles, with owner/ADMINISTRATOR short-circuits. */
export function computeBasePermissions(guild: GuildInfo, member: MemberInfo): bigint {
  if (isGuildOwner(guild, member)) return ALL_PERMISSIONS;
  const roleById = new Map(guild.roles.map((role) => [role.id, role]));
  // The @everyone role has the same id as the guild.
  let permissions = roleById.get(guild.id)?.permissions ?? 0n;
  for (const roleId of member.roles) {
    permissions |= roleById.get(roleId)?.permissions ?? 0n;
  }
  if (hasPermission(permissions, ADMINISTRATOR)) return ALL_PERMISSIONS;
  return permissions;
}

/**
 * Applies channel overwrites in Discord's documented order: @everyone, roles (aggregated), member;
 * each denies before it allows. ADMINISTRATOR is not subject to overwrites.
 * https://docs.discord.com/developers/topics/permissions
 */
function applyOverwrites(
  basePermissions: bigint,
  guild: GuildInfo,
  member: MemberInfo,
  overwrites: readonly PermissionOverwrite[],
): bigint {
  if (hasPermission(basePermissions, ADMINISTRATOR)) return ALL_PERMISSIONS;
  let permissions = basePermissions;

  const everyone = overwrites.find((o) => o.type === OverwriteType.Role && o.id === guild.id);
  if (everyone) {
    permissions &= ~everyone.deny;
    permissions |= everyone.allow;
  }

  const memberRoles = new Set(member.roles);
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === OverwriteType.Role && overwrite.id !== guild.id && memberRoles.has(overwrite.id)) {
      roleAllow |= overwrite.allow;
      roleDeny |= overwrite.deny;
    }
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const memberOverwrite = overwrites.find((o) => o.type === OverwriteType.Member && o.id === member.userId);
  if (memberOverwrite) {
    permissions &= ~memberOverwrite.deny;
    permissions |= memberOverwrite.allow;
  }

  return permissions;
}

export function computeChannelPermissions(guild: GuildInfo, member: MemberInfo, overwrites: readonly PermissionOverwrite[]): bigint {
  return applyOverwrites(computeBasePermissions(guild, member), guild, member, overwrites);
}
