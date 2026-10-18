import type { OverwriteType } from "discord-api-types/v10";

export interface RoleInfo {
  id: string;
  name: string;
  permissions: bigint;
  /** RGB integer; 0 means the role has no color. */
  color: number;
  position: number;
  /** Managed by an integration (bot roles, booster role). */
  managed: boolean;
}

export interface UserInfo {
  id: string;
  username: string;
  globalName: string | null;
  /** Discord CDN URL; null for the default avatar. */
  avatarUrl: string | null;
}

export interface GuildInfo {
  id: string;
  name: string;
  /** Discord CDN URL; null without an icon. */
  iconUrl: string | null;
  ownerId: string;
  roles: RoleInfo[];
}

export interface MemberInfo {
  userId: string;
  roles: string[];
  nick: string | null;
  username: string;
  globalName: string | null;
  /** Discord CDN URL (server avatar first); null for the default avatar. */
  avatarUrl: string | null;
}

/** A member from the guild member list, which also includes bots. */
export interface ListedMember extends MemberInfo {
  bot: boolean;
}

export interface PermissionOverwrite {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}
