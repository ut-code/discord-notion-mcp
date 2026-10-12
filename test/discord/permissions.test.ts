import { describe, expect, test } from "bun:test";
import {
  ADMINISTRATOR,
  ALL_PERMISSIONS,
  READ_MESSAGE_HISTORY,
  VIEW_CHANNEL,
  canReadMessages,
  canViewChannel,
  computeBasePermissions,
  computeChannelPermissions,
} from "../../src/lib/server/discord/permissions";
import { OverwriteType, type PermissionOverwrite } from "../../src/lib/server/discord/types";
import { GUILD_ID, OWNER_ID, makeGuild, makeMember } from "../support/fakes";

const READ = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const ROLE_A = "200000000000000001";
const ROLE_B = "200000000000000002";
const USER = "300000000000000001";

function everyone(allow: bigint, deny: bigint): PermissionOverwrite {
  return { id: GUILD_ID, type: OverwriteType.Role, allow, deny };
}
function role(id: string, allow: bigint, deny: bigint): PermissionOverwrite {
  return { id, type: OverwriteType.Role, allow, deny };
}
function member(id: string, allow: bigint, deny: bigint): PermissionOverwrite {
  return { id, type: OverwriteType.Member, allow, deny };
}

describe("computeBasePermissions", () => {
  test("@everyone permissions apply to all members", () => {
    const guild = makeGuild([{ id: GUILD_ID, permissions: READ }]);
    expect(computeBasePermissions(guild, makeMember(USER))).toBe(READ);
  });

  test("member role permissions are OR-ed with @everyone", () => {
    const guild = makeGuild([
      { id: GUILD_ID, permissions: VIEW_CHANNEL },
      { id: ROLE_A, permissions: READ_MESSAGE_HISTORY },
    ]);
    expect(computeBasePermissions(guild, makeMember(USER, [ROLE_A]))).toBe(READ);
  });

  test("guild owner gets every permission", () => {
    expect(computeBasePermissions(makeGuild(), makeMember(OWNER_ID))).toBe(ALL_PERMISSIONS);
  });

  test("ADMINISTRATOR role grants every permission", () => {
    const guild = makeGuild([{ id: ROLE_A, permissions: ADMINISTRATOR }]);
    expect(computeBasePermissions(guild, makeMember(USER, [ROLE_A]))).toBe(ALL_PERMISSIONS);
  });

  test("unknown role ids are ignored", () => {
    const guild = makeGuild([{ id: GUILD_ID, permissions: VIEW_CHANNEL }]);
    expect(computeBasePermissions(guild, makeMember(USER, ["999999999999999999"]))).toBe(VIEW_CHANNEL);
  });
});

describe("computeChannelPermissions", () => {
  const baseGuild = makeGuild([{ id: GUILD_ID, permissions: READ }]);

  test("no overwrites keeps base permissions", () => {
    const perms = computeChannelPermissions(baseGuild, makeMember(USER), []);
    expect(canReadMessages(perms)).toBe(true);
  });

  test("owner can read even when @everyone is denied", () => {
    const perms = computeChannelPermissions(baseGuild, makeMember(OWNER_ID), [everyone(0n, VIEW_CHANNEL)]);
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  test("admin role bypasses channel denies", () => {
    const guild = makeGuild([
      { id: GUILD_ID, permissions: READ },
      { id: ROLE_A, permissions: ADMINISTRATOR },
    ]);
    const perms = computeChannelPermissions(guild, makeMember(USER, [ROLE_A]), [
      everyone(0n, VIEW_CHANNEL),
      member(USER, 0n, VIEW_CHANNEL),
    ]);
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  test("@everyone deny hides the channel", () => {
    const perms = computeChannelPermissions(baseGuild, makeMember(USER), [everyone(0n, VIEW_CHANNEL)]);
    expect(canViewChannel(perms)).toBe(false);
  });

  test("role allow overrides @everyone deny", () => {
    const perms = computeChannelPermissions(baseGuild, makeMember(USER, [ROLE_A]), [
      everyone(0n, VIEW_CHANNEL),
      role(ROLE_A, VIEW_CHANNEL, 0n),
    ]);
    expect(canReadMessages(perms)).toBe(true);
  });

  test("role overwrites for roles the member lacks do not apply", () => {
    const perms = computeChannelPermissions(baseGuild, makeMember(USER), [everyone(0n, VIEW_CHANNEL), role(ROLE_A, VIEW_CHANNEL, 0n)]);
    expect(canViewChannel(perms)).toBe(false);
  });

  test("role allow wins over another role's deny (aggregated deny then allow)", () => {
    const perms = computeChannelPermissions(baseGuild, makeMember(USER, [ROLE_A, ROLE_B]), [
      role(ROLE_A, 0n, VIEW_CHANNEL),
      role(ROLE_B, VIEW_CHANNEL, 0n),
    ]);
    expect(canViewChannel(perms)).toBe(true);
  });

  test("member deny overrides role allow", () => {
    const perms = computeChannelPermissions(baseGuild, makeMember(USER, [ROLE_A]), [
      everyone(0n, VIEW_CHANNEL),
      role(ROLE_A, VIEW_CHANNEL, 0n),
      member(USER, 0n, VIEW_CHANNEL),
    ]);
    expect(canViewChannel(perms)).toBe(false);
  });

  test("member allow overrides role deny", () => {
    const perms = computeChannelPermissions(baseGuild, makeMember(USER, [ROLE_A]), [
      role(ROLE_A, 0n, VIEW_CHANNEL),
      member(USER, VIEW_CHANNEL, 0n),
    ]);
    expect(canViewChannel(perms)).toBe(true);
  });

  test("reading requires READ_MESSAGE_HISTORY in addition to VIEW_CHANNEL", () => {
    const perms = computeChannelPermissions(baseGuild, makeMember(USER), [everyone(0n, READ_MESSAGE_HISTORY)]);
    expect(canViewChannel(perms)).toBe(true);
    expect(canReadMessages(perms)).toBe(false);
  });

  test("@everyone overwrite can grant what the base lacks", () => {
    const guild = makeGuild([{ id: GUILD_ID, permissions: 0n }]);
    const perms = computeChannelPermissions(guild, makeMember(USER), [everyone(READ, 0n)]);
    expect(canReadMessages(perms)).toBe(true);
  });

  test("@everyone role with ADMINISTRATOR makes everyone admin", () => {
    const guild = makeGuild([{ id: GUILD_ID, permissions: ADMINISTRATOR }]);
    expect(computeChannelPermissions(guild, makeMember(USER), [everyone(0n, VIEW_CHANNEL)])).toBe(ALL_PERMISSIONS);
  });
});
