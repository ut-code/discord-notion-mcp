import { beforeEach, describe, expect, test } from "bun:test";
import { GrantStore } from "../../src/lib/server/permissions/grants";
import { PERMISSIONS } from "../../src/lib/server/permissions/permissions";
import { PermissionResolver } from "../../src/lib/server/permissions/resolver";
import { openDatabase, runAppMigrations } from "../../src/lib/server/db/client";
import { CachedGuildDirectory } from "../../src/lib/server/discord/directory";
import { ADMINISTRATOR, VIEW_CHANNEL } from "../../src/lib/server/discord/permissions";
import { FakeClock, FakeDiscordApi, GUILD_ID, OWNER_ID, makeGuild, makeMember } from "../../src/lib/server/fakes/discord";

const USER = "300000000000000001";
const ROLE_MOD = "200000000000000001";
const ROLE_ADMIN = "200000000000000002";

let api: FakeDiscordApi;
let clock: FakeClock;
let grants: GrantStore;
let resolver: PermissionResolver;

beforeEach(() => {
  const { db } = openDatabase(":memory:");
  runAppMigrations(db);
  grants = new GrantStore(db);
  api = new FakeDiscordApi();
  api.guild = makeGuild([
    { id: ROLE_MOD, permissions: VIEW_CHANNEL },
    { id: ROLE_ADMIN, permissions: ADMINISTRATOR },
  ]);
  clock = new FakeClock();
  resolver = new PermissionResolver(new CachedGuildDirectory(api, { ttlMs: 60_000, clock: clock.fn }), grants);
});

describe("PermissionResolver", () => {
  test("non-member gets no permissions", async () => {
    await grants.createGrant({ permission: "discord:read", subjectType: "user", subjectId: USER });
    const access = await resolver.resolve(USER);
    expect(access.isMember).toBe(false);
    expect(access.permissions.size).toBe(0);
  });

  test("guild owner is admin with every permission", async () => {
    api.members.set(OWNER_ID, makeMember(OWNER_ID));
    const access = await resolver.resolve(OWNER_ID);
    expect(access.isAdmin).toBe(true);
    expect([...access.permissions].sort()).toEqual([...PERMISSIONS].sort());
  });

  test("ADMINISTRATOR role makes the member admin", async () => {
    api.members.set(USER, makeMember(USER, [ROLE_ADMIN]));
    const access = await resolver.resolve(USER);
    expect(access.isAdmin).toBe(true);
    expect(access.permissions.has("notion:write")).toBe(true);
  });

  test("ADMINISTRATOR on @everyone makes every member admin", async () => {
    api.guild = makeGuild([{ id: GUILD_ID, permissions: ADMINISTRATOR }]);
    api.members.set(USER, makeMember(USER));
    expect((await resolver.resolve(USER)).isAdmin).toBe(true);
  });

  test("member without grants has no permissions", async () => {
    api.members.set(USER, makeMember(USER, [ROLE_MOD]));
    const access = await resolver.resolve(USER);
    expect(access.isMember).toBe(true);
    expect(access.isAdmin).toBe(false);
    expect(access.permissions.size).toBe(0);
  });

  test("role grant applies to members holding the role", async () => {
    await grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    api.members.set(USER, makeMember(USER, [ROLE_MOD]));
    const other = "300000000000000002";
    api.members.set(other, makeMember(other));
    expect([...(await resolver.resolve(USER)).permissions]).toEqual(["discord:read"]);
    expect((await resolver.resolve(other)).permissions.size).toBe(0);
  });

  test("user grant applies only to that user", async () => {
    await grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: USER });
    api.members.set(USER, makeMember(USER));
    expect([...(await resolver.resolve(USER)).permissions]).toEqual(["notion:read"]);
  });

  test("@everyone grant (role id == guild id) applies to every member", async () => {
    await grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: GUILD_ID });
    api.members.set(USER, makeMember(USER));
    expect((await resolver.resolve(USER)).permissions.has("discord:read")).toBe(true);
  });

  test("grants union across user and roles", async () => {
    await grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    await grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: USER });
    api.members.set(USER, makeMember(USER, [ROLE_MOD]));
    expect([...(await resolver.resolve(USER)).permissions].sort()).toEqual(["discord:read", "notion:read"]);
  });

  test("Notion write includes Notion read", async () => {
    await grants.createGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    api.members.set(USER, makeMember(USER, [ROLE_MOD]));
    expect([...(await resolver.resolve(USER)).permissions].sort()).toEqual(["notion:read", "notion:write"]);
  });

  test("an explicit admin grant implies every permission", async () => {
    await grants.createGrant({ permission: "admin", subjectType: "user", subjectId: USER });
    api.members.set(USER, makeMember(USER));
    const access = await resolver.resolve(USER);
    expect(access.isAdmin).toBe(true);
    expect(access.permissions.size).toBe(PERMISSIONS.length);
  });

  test("guild and member lookups are cached for 60s", async () => {
    api.members.set(USER, makeMember(USER));
    await resolver.resolve(USER);
    await resolver.resolve(USER);
    expect(api.calls).toMatchObject({ guild: 1, member: 1 });

    api.members.delete(USER);
    clock.advance(59_999);
    expect((await resolver.resolve(USER)).isMember).toBe(true);
    expect(api.calls).toMatchObject({ guild: 1, member: 1 });

    clock.advance(2);
    expect((await resolver.resolve(USER)).isMember).toBe(false);
    expect(api.calls).toMatchObject({ guild: 2, member: 2 });
  });

  test("non-membership is cached too", async () => {
    await resolver.resolve(USER);
    api.members.set(USER, makeMember(USER));
    expect((await resolver.resolve(USER)).isMember).toBe(false);
    clock.advance(60_001);
    expect((await resolver.resolve(USER)).isMember).toBe(true);
  });
});

describe("GrantStore", () => {
  test("createGrant is idempotent and removeGrant reports removal", async () => {
    const first = await grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD, createdBy: USER });
    const second = await grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.grant.id).toBe(first.grant.id);
    expect(first.grant.createdBy).toBe(USER);
    expect(await grants.listGrants()).toHaveLength(1);
    expect(await grants.removeGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD })).toBe(true);
    expect(await grants.removeGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD })).toBe(false);
  });
});
