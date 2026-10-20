import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN_ONLY, checkViewer, signInRedirect, type Viewer } from "../../src/lib/server/dashboard/access";
import { auditDetail, auditList, revertAudit } from "../../src/lib/server/dashboard/audit";
import type { DashboardDeps } from "../../src/lib/server/dashboard/deps";
import { createGrant, deleteGrant, grantsPage, memberSearchResult } from "../../src/lib/server/dashboard/grants";
import { requireAdminViewer } from "../../src/lib/server/dashboard/guard";
import { MemberRoster } from "../../src/lib/server/dashboard/member-roster";
import {
  consentPage,
  metadataHost,
  NOT_MEMBER,
  redirectTarget,
  signInErrorMessage,
  signInPage,
  signOut,
} from "../../src/lib/server/dashboard/session";
import { revokeTokens, USER_SEARCH_SCAN_LIMIT, usersPage, type UserTableRow } from "../../src/lib/server/dashboard/users";
import type { LoginUser } from "../../src/lib/server/auth/users";
import { ADMINISTRATOR } from "../../src/lib/server/discord/permissions";
import type { Actor } from "../../src/lib/server/notion/changes/attribution";
import { auditNoteText } from "../../src/lib/server/dashboard/outcome-text";
import { NotionAuditService } from "../../src/lib/server/notion/changes/audit-service";
import { NotionAuditStore } from "../../src/lib/server/notion/changes/audit-store";
import type { RevertNote } from "../../src/lib/server/notion/changes/audit-records";
import { NotionWriteService } from "../../src/lib/server/notion/changes/write-service";
import { overwriteAuditRow } from "../support/audit-rows";
import { FakeDiscordApi, makeGuild, makeMember, OWNER_ID } from "../support/fakes";
import {
  authorize,
  issueTokens,
  mcpCall,
  newSessionCookie,
  REDIRECT_URI,
  refreshTokens,
  registerClient,
  signIn,
  startHarness,
  type Harness,
} from "../support/harness";

const ROLE_ADMIN = "200000000000000001";
const ROLE_MOD = "200000000000000002";
const ROLE_BOT = "200000000000000003";
const ADMIN_MEMBER = "300000000000000010";
const MEMBER = "300000000000000011";
const GRANTED_ADMIN = "300000000000000012";
const OUTSIDER = "300000000000000013";
const FLAKY = "300000000000000014";
const STRANGER = "300000000000000015";
const READER = "300000000000000016";
const NEWCOMER = "300000000000000017";
const OWNER_AVATAR = "https://cdn.discordapp.com/avatars/100000000000000001/0123456789abcdef0123456789abcdef.png?size=64";

let h: Harness;
let deps: DashboardDeps;
let owner: Viewer;
let ownerUserId = "";
let writes: NotionWriteService;
let store: NotionAuditStore;

const MEMBER_ACTOR: Actor = { discordUserId: MEMBER, displayName: "Mina", username: "mina" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const params = (query = "") => new URLSearchParams(query);
const gate = (cookie: string) => checkViewer(deps, new Headers({ cookie }));

async function viewerFor(discordUserId: string): Promise<Viewer> {
  const result = await gate((await signIn(h, discordUserId)).cookie);
  if (result.kind !== "viewer") throw new Error(`not a viewer: ${result.kind}`);
  return result.viewer;
}

async function adminFor(discordUserId: string): Promise<Viewer> {
  const viewer = await viewerFor(discordUserId);
  if (!viewer.isAdmin) throw new Error(`not an admin: ${discordUserId}`);
  return viewer;
}

async function userRow(userId: string, query = "", viewer: Viewer = owner): Promise<UserTableRow> {
  const row = (await usersPage(deps, params(query), viewer)).rows.find((candidate) => candidate.userId === userId);
  if (!row) throw new Error(`no row for ${userId}`);
  return row;
}

async function consentFor(discordUserId: string) {
  const { cookie } = await signIn(h, discordUserId);
  const clientId = await registerClient(h);
  const res = await authorize(h, clientId, cookie);
  const location = new URL(res.headers.get("location")!, h.base);
  expect(location.pathname).toBe("/consent");
  const page = await consentPage(deps, location, new Headers({ cookie }));
  if (page.kind !== "ok") throw new Error(`consent: ${page.kind}`);
  return page.data;
}

beforeAll(async () => {
  const discord = new FakeDiscordApi();
  discord.guild = makeGuild([
    { id: ROLE_ADMIN, name: "Staff", permissions: ADMINISTRATOR, color: 0xe91e63, position: 3 },
    { id: ROLE_MOD, name: "Moderator", permissions: 0n, color: 0x3498db, position: 2 },
    { id: ROLE_BOT, name: "SomeBot", permissions: 0n, position: 1, managed: true },
  ]);
  discord.members.set(OWNER_ID, { ...makeMember(OWNER_ID), username: "owner", globalName: "The Owner", avatarUrl: OWNER_AVATAR });
  discord.members.set(ADMIN_MEMBER, makeMember(ADMIN_MEMBER, [ROLE_ADMIN]));
  discord.members.set(MEMBER, { ...makeMember(MEMBER, [ROLE_MOD]), username: "mina", nick: "Mina" });
  discord.members.set(GRANTED_ADMIN, makeMember(GRANTED_ADMIN));
  discord.members.set(READER, { ...makeMember(READER), username: "reader", globalName: "Reader" });
  discord.members.set(NEWCOMER, makeMember(NEWCOMER));
  discord.users.set(STRANGER, { id: STRANGER, username: "stranger", globalName: "Stranger", avatarUrl: null });
  discord.failingMembers.add(FLAKY);
  h = await startHarness({ discord });
  deps = h.server.dashboard;
  ownerUserId = (await signIn(h, OWNER_ID)).userId;
  owner = await adminFor(OWNER_ID);
  store = new NotionAuditStore(h.server.database.db);
  writes = new NotionWriteService(h.notion, store);
});

afterAll(async () => {
  await h?.stop();
});

describe("dashboard access control", () => {
  test("without a session the sign-in redirect keeps the requested page", async () => {
    expect(await checkViewer(deps, new Headers())).toEqual({ kind: "signed-out" });
    expect(signInRedirect(new URL("http://x/dashboard"), "GET")).toBe("/sign-in?next=%2Fdashboard");
    expect(signInRedirect(new URL("http://x/dashboard/audit?status=ok"), "GET")).toBe(
      `/sign-in?next=${encodeURIComponent("/dashboard/audit?status=ok")}`,
    );
    expect(signInRedirect(new URL("http://x/dashboard/grants?/create"), "POST")).toBe("/sign-in?next=%2Fdashboard");
  });

  test("non-admin members are read-only viewers; non-members are denied with 403", async () => {
    const member = await viewerFor(MEMBER);
    expect(member).toMatchObject({ discordUserId: MEMBER, roleLabel: "メンバー", isAdmin: false, canViewAudit: false });
    const outsider = await gate((await signIn(h, OUTSIDER)).cookie);
    expect(outsider).toEqual({ kind: "denied", status: 403, ...NOT_MEMBER });
  });

  test("the write history needs notion:write (or admin); notion:read alone is not enough", async () => {
    await h.server.grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: READER });
    try {
      expect((await viewerFor(READER)).canViewAudit).toBe(false);
      await h.server.grants.createGrant({ permission: "notion:write", subjectType: "user", subjectId: READER });
      expect(await viewerFor(READER)).toMatchObject({ isAdmin: false, canViewAudit: true });
    } finally {
      await h.server.grants.removeGrant({ permission: "notion:read", subjectType: "user", subjectId: READER });
      await h.server.grants.removeGrant({ permission: "notion:write", subjectType: "user", subjectId: READER });
    }
    expect(owner.canViewAudit).toBe(true);
  });

  test("a failing membership check yields 503", async () => {
    expect(await gate((await signIn(h, FLAKY)).cookie)).toMatchObject({ kind: "denied", status: 503, title: "一時的に確認できません" });
  });

  test("owner, ADMINISTRATOR role holders and explicit admin grants are admins", async () => {
    await h.server.grants.createGrant({ permission: "admin", subjectType: "user", subjectId: GRANTED_ADMIN });
    expect((await adminFor(ADMIN_MEMBER)).roleLabel).toBe("管理者");
    expect((await adminFor(GRANTED_ADMIN)).roleLabel).toBe("管理者");
  });

  test("the sidebar view names the server and the signed-in viewer", () => {
    expect(owner).toEqual({
      discordUserId: OWNER_ID,
      displayName: "The Owner",
      username: "owner",
      avatarUrl: OWNER_AVATAR,
      roleLabel: "オーナー",
      guildName: "Test Guild",
      guildIconUrl: null,
      isAdmin: true,
      canViewAudit: true,
      permissions: ["discord:read", "notion:read", "notion:write", "admin"],
    });
  });

  test("an unknown audit id is not found", async () => {
    expect(await auditDetail(deps, "99999", owner)).toBeNull();
    expect(await auditDetail(deps, "abc", owner)).toBeNull();
  });
});

describe("grants", () => {
  test("the form knows before granting what is already granted and what would add nothing, and why", async () => {
    await h.server.grants.createGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    await h.server.grants.createGrant({ permission: "discord:read", subjectType: "user", subjectId: MEMBER });
    const page = await grantsPage(deps, params());
    expect(page.form.members.find((member) => member.id === MEMBER)).toMatchObject({
      granted: ["discord:read"],
      notices: {
        "notion:read": "@Moderator ロールで既に付与されているため、付与しても効果がありません。",
        "notion:write": "@Moderator ロールで既に付与されているため、付与しても効果がありません。",
      },
    });
    expect(page.form.roles.find((role) => role.id === ROLE_MOD)).toMatchObject({
      granted: ["notion:write"],
      notices: { "notion:read": "Notion 編集に含まれるため、付与しても効果がありません。" },
    });
    expect(page.form.members.find((member) => member.id === ADMIN_MEMBER)?.notices["discord:read"]).toBe(
      "管理者の権限があるため、付与しても効果がありません。",
    );
    expect((await memberSearchResult(deps, "mi", owner)).body).toMatchObject({ members: [{ id: MEMBER, granted: ["discord:read"] }] });

    await h.server.grants.removeGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    await h.server.grants.removeGrant({ permission: "discord:read", subjectType: "user", subjectId: MEMBER });
  });

  test("adds a role grant, reports duplicates, and deletes it", async () => {
    const fields = { permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD };
    expect(await createGrant(deps, form(fields), owner)).toEqual({
      kind: "ok",
      message: "ロール「Moderator」に「Discord 閲覧」を付与しました。",
    });
    const stored = (await h.server.grants.listGrants()).find((grant) => grant.subjectId === ROLE_MOD);
    expect(stored).toMatchObject({ permission: "discord:read", subjectType: "role", createdBy: OWNER_ID });
    expect(h.events).toContainEqual({
      event: "grant_added",
      permission: "discord:read",
      subjectType: "role",
      subjectId: ROLE_MOD,
      by: OWNER_ID,
    });
    const row = (await grantsPage(deps, params())).rows.find((candidate) => candidate.key === `role:${ROLE_MOD}:discord:read`);
    expect(row?.subject).toMatchObject({ name: "@Moderator", color: "#3498db", secondary: "ロール" });
    expect(row?.remove).toMatchObject({
      label: "@Moderator の Discord 閲覧を削除",
      menuLabel: "@Moderator の Discord 閲覧の操作",
      confirm: "@Moderator の Discord 閲覧を削除しますか？",
    });

    expect(await createGrant(deps, form(fields), owner)).toMatchObject({
      kind: "warn",
      message: "ロール「Moderator」には既に「Discord 閲覧」が付与されています。",
    });

    expect(await deleteGrant(deps, form(fields), owner)).toEqual({
      kind: "ok",
      message: "@Moderator から「Discord 閲覧」を削除しました。",
    });
    expect((await h.server.grants.listGrants()).some((grant) => grant.subjectId === ROLE_MOD)).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ event: "grant_removed", subjectId: ROLE_MOD });
    expect(await deleteGrant(deps, form(fields), owner)).toMatchObject({ kind: "warn", message: "この付与は既に削除されています。" });
  });

  test("the grant form sends the subject as role:<id> or user:<id>", async () => {
    const byRole = await createGrant(deps, form({ permission: "notion:read", subject: `role:${ROLE_MOD}` }), owner);
    expect(byRole.message).toBe("ロール「Moderator」に「Notion 閲覧」を付与しました。");
    const byUser = await createGrant(deps, form({ permission: "notion:read", subject: `user:${READER}` }), owner);
    expect(byUser.message).toBe("ユーザー「Reader」に「Notion 閲覧」を付与しました。");
    for (const subject of [undefined, "user:"]) {
      expect(await createGrant(deps, form({ permission: "notion:read", ...(subject ? { subject } : {}) }), owner)).toEqual({
        kind: "error",
        message: "対象を選んでください。",
      });
    }
    expect((await createGrant(deps, form({ permission: "notion:read", subject: `team:${MEMBER}` }), owner)).message).toBe(
      "対象の種類が不正です。",
    );
    await h.server.grants.removeGrant({ permission: "notion:read", subjectType: "role", subjectId: ROLE_MOD });
    await h.server.grants.removeGrant({ permission: "notion:read", subjectType: "user", subjectId: READER });
  });

  test("rejects invalid snowflakes, unknown permissions and integration roles", async () => {
    const before = (await h.server.grants.listGrants()).length;
    expect((await createGrant(deps, form({ permission: "notion:read", subjectType: "user", subjectId: "12ab" }), owner)).message).toContain(
      "Discord の ID（15〜22 桁の数字）ではありません",
    );
    expect(await createGrant(deps, form({ permission: "root", subjectType: "user", subjectId: MEMBER }), owner)).toEqual({
      kind: "error",
      message: "不明な権限です。",
    });
    expect(await createGrant(deps, form({ permission: "notion:read", subjectType: "team", subjectId: MEMBER }), owner)).toEqual({
      kind: "error",
      message: "対象の種類が不正です。",
    });
    expect(
      (await createGrant(deps, form({ permission: "notion:read", subjectType: "role", subjectId: ROLE_BOT }), owner)).message,
    ).toContain("ロールを選んでください");
    expect((await h.server.grants.listGrants()).length).toBe(before);
  });

  test("user grants show resolved names and roles; the role picker excludes integration roles", async () => {
    for (const subjectId of [MEMBER, STRANGER, "399999999999999999"]) {
      await createGrant(deps, form({ permission: "notion:read", subjectType: "user", subjectId }), owner);
    }
    const data = await grantsPage(deps, params());
    const subjects = data.rows.map((row) => row.subject);
    expect(subjects).toContainEqual(
      expect.objectContaining({ name: "Mina", secondary: "@mina · Moderator", title: `Discord ID ${MEMBER}` }),
    );
    expect(subjects).toContainEqual(expect.objectContaining({ name: "Stranger", secondary: "@stranger · 非メンバー" }));
    expect(subjects).toContainEqual(expect.objectContaining({ name: "399999999999999999", secondary: "不明なユーザー", unknown: true }));
    expect(data.rows.find((row) => row.subject.name === "Mina")?.remove?.label).toBe("Mina の Notion 閲覧を削除");
    expect(data.form?.roles.map((role) => role.label)).toEqual(["@Staff", "@Moderator", "@everyone"]);
  });

  test("implicit admins are listed as locked rows under すべて and 管理者", async () => {
    const all = await grantsPage(deps, params());
    expect(all.rows[0]).toMatchObject({
      subject: { name: "@Staff" },
      permissionLabel: "管理者",
      locked: "Discord 側の権限なのでここでは削除できません",
      remove: null,
    });
    expect(all.rows[1]).toMatchObject({ subject: { name: "The Owner" }, locked: "サーバーオーナーは常に管理者です" });
    expect(all.tabs[0]).toMatchObject({ label: "すべて", count: all.rows.length, active: true });

    const admins = await grantsPage(deps, params("filter=admin"));
    expect(admins.rows.some((row) => row.key.startsWith("owner:"))).toBe(true);
    expect(admins.tabs.find((tab) => tab.active)).toMatchObject({ href: "/dashboard/grants?filter=admin", label: "管理者" });
    const readers = await grantsPage(deps, params("filter=notion%3Aread"));
    expect(readers.rows.some((row) => row.key.startsWith("owner:"))).toBe(false);
    expect(readers.rows.some((row) => row.subject.secondary === "@mina · Moderator")).toBe(true);
    expect(readers.form?.permission).toBe("notion:read");
    // Each tab counts the rows it shows, so the counts match the filtered lists.
    expect(all.tabs.find((tab) => tab.label === "管理者")?.count).toBe(admins.rows.length);
    expect(all.tabs.find((tab) => tab.label === "Notion 閲覧")?.count).toBe(readers.rows.length);
  });

  test("individual grants already provided by a role or by admin status are flagged", async () => {
    await h.server.grants.createGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    await h.server.grants.createGrant({ permission: "notion:write", subjectType: "user", subjectId: MEMBER });
    await h.server.grants.createGrant({ permission: "discord:read", subjectType: "user", subjectId: ADMIN_MEMBER });
    const badges = (await grantsPage(deps, params())).rows.flatMap((row) => (row.redundancy ? [row.redundancy] : []));
    expect(badges).toContainEqual({
      label: "@Moderator で付与済み",
      tone: "warn",
      title: "@Moderator ロールで既に付与されているため、この付与は効果がありません",
    });
    expect(badges.map((badge) => badge.label)).toContain("管理者で付与済み");

    await h.server.grants.removeGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    await h.server.grants.removeGrant({ permission: "notion:write", subjectType: "user", subjectId: MEMBER });
    await h.server.grants.removeGrant({ permission: "discord:read", subjectType: "user", subjectId: ADMIN_MEMBER });
    expect((await grantsPage(deps, params())).rows.some((row) => row.redundancy)).toBe(false);
  });

  test("a Notion read grant is flagged when Notion write already gives it", async () => {
    await h.server.grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: MEMBER });
    await h.server.grants.createGrant({ permission: "notion:write", subjectType: "user", subjectId: MEMBER });
    expect((await grantsPage(deps, params())).rows.flatMap((row) => (row.redundancy ? [row.redundancy] : []))).toEqual([
      {
        label: "Notion 編集に含まれる",
        tone: "warn",
        title: "Notion 編集に含まれるため、この付与は効果がありません",
      },
    ]);

    await h.server.grants.removeGrant({ permission: "notion:write", subjectType: "user", subjectId: MEMBER });
    await h.server.grants.createGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    expect((await grantsPage(deps, params())).rows.flatMap((row) => (row.redundancy ? [row.redundancy.label] : []))).toEqual([
      "@Moderator で付与済み",
    ]);
    await h.server.grants.removeGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    await h.server.grants.removeGrant({ permission: "notion:read", subjectType: "user", subjectId: MEMBER });
  });

  test("the form lists every role and the members by name; a search and a chosen subject come from the URL", async () => {
    const plain = await grantsPage(deps, params());
    expect(plain.form).toMatchObject({ query: "", results: [], selected: null, moreMembers: 0, submitLabel: "付与する" });
    expect(plain.form.roles.find((role) => role.id === ROLE_MOD)).toEqual({
      key: `role:${ROLE_MOD}`,
      type: "role",
      id: ROLE_MOD,
      label: "@Moderator",
      secondLine: null,
      color: "#3498db",
      avatarUrl: null,
      granted: [],
      notices: {},
    });
    const labels = plain.form.members.map((member) => member.label);
    expect(labels).toEqual([...labels].sort(new Intl.Collator("ja").compare));
    expect(labels).toContain("Mina");

    const search = await grantsPage(deps, params("q=ina&permission=notion%3Awrite"));
    expect(search.form).toMatchObject({ permission: "notion:write", query: "ina" });
    expect(search.form.results.map((member) => member.id)).toEqual([MEMBER]);
    expect(search.form.permissions.find((option) => option.value === "notion:write")?.hint).toBe(
      "ページの閲覧に加えて、作成・編集・アーカイブができます。すべての操作は記録され、あとから取り消せます。",
    );
    expect((await grantsPage(deps, params(`q=${STRANGER}`))).form.results.map((member) => member.id)).toEqual([STRANGER]);
    expect((await grantsPage(deps, params("q=zzz"))).form.results).toEqual([]);

    const chosenUser = await grantsPage(deps, params(`subject=user%3A${MEMBER}&permission=notion%3Awrite`));
    expect(chosenUser.form.selected).toMatchObject({ key: `user:${MEMBER}`, label: "Mina" });
    expect(chosenUser.form.submitLabel).toBe("Mina に Notion 編集を付与");
    expect((await grantsPage(deps, params(`subject=role%3A${ROLE_MOD}`))).form.submitLabel).toBe("@Moderator に Discord 閲覧を付与");
    expect((await grantsPage(deps, params("subject=role%3A12ab"))).form.selected).toBeNull();
  });

  test("the member search matches any part of a name and validates the query; admins only", async () => {
    expect(await memberSearchResult(deps, "in", owner)).toEqual({
      status: 200,
      body: {
        members: [
          {
            key: `user:${MEMBER}`,
            type: "user",
            id: MEMBER,
            label: "Mina",
            secondLine: "@mina · Moderator",
            color: null,
            avatarUrl: null,
            granted: [],
            notices: {},
          },
        ],
      },
    });
    expect((await memberSearchResult(deps, "ＥＡＤ", owner)).body).toMatchObject({ members: [{ id: READER }] });
    expect((await memberSearchResult(deps, `@${STRANGER}`, owner)).body).toMatchObject({ members: [{ id: STRANGER, label: "Stranger" }] });
    expect(await memberSearchResult(deps, "zzz", owner)).toEqual({ status: 200, body: { members: [] } });
    for (const query of [null, "", "   ", "x".repeat(101)]) {
      expect(await memberSearchResult(deps, query, owner)).toEqual({
        status: 400,
        body: { error: "検索語は 1〜100 文字で入力してください。" },
      });
    }
    expect((await memberSearchResult(deps, ` ${"x".repeat(100)} `, owner)).status).toBe(200);

    let searched = false;
    const spied = { ...deps, members: { ...deps.members, search: async () => ((searched = true), []) } };
    expect(await memberSearchResult(spied, "mi", await viewerFor(MEMBER))).toEqual({
      status: 403,
      body: { error: "この操作は管理者だけが行えます。" },
    });
    expect(searched).toBe(false);
  });

  const listedMembers = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const id = String(400000000000000000n + BigInt(index));
      return { ...makeMember(id), username: `member${String(index).padStart(5, "0")}` };
    });

  test("the member roster is listed page by page without bots and cached for a minute; failures are not cached", async () => {
    const discord = new FakeDiscordApi();
    for (const member of listedMembers(1001)) discord.members.set(member.userId, member);
    discord.members.set("499999999999999999", { ...makeMember("499999999999999999"), username: "a-bot" });
    discord.bots.add("499999999999999999");
    const pages: Array<string | undefined> = [];
    let failing = false;
    const listMembers = discord.listMembers.bind(discord);
    discord.listMembers = async (limit, after) => {
      pages.push(after);
      if (failing) throw new Error("discord down");
      return listMembers(limit, after);
    };
    let now = 0;
    const roster = new MemberRoster(discord, deps.subjects, () => now);

    const [first] = await Promise.all([roster.roster(), roster.roster()]);
    expect(first).toMatchObject({ complete: true });
    expect(first.members).toHaveLength(1001);
    expect(first.members.some((member) => member.username === "a-bot")).toBe(false);
    expect(pages).toEqual([undefined, "400000000000000999"]);
    await roster.search("member0", 5);
    expect(pages).toHaveLength(2);

    now = 60_000;
    failing = true;
    const failingDeps = { ...deps, members: roster, logError: () => {} };
    expect(await memberSearchResult(failingDeps, "member", owner)).toEqual({
      status: 502,
      body: { error: "メンバー検索に失敗しました。しばらくしてから再試行してください。" },
    });
    expect((await grantsPage(failingDeps, params())).form).toMatchObject({
      members: [],
      membersError: "メンバーを取得できませんでした。しばらくしてから再読み込みしてください。",
    });
    failing = false;
    expect((await memberSearchResult(failingDeps, "member01000", owner)).body).toMatchObject({ members: [{ id: "400000000000001000" }] });
  });

  test("a guild too large to list is searched by name prefix on Discord as well", async () => {
    const discord = new FakeDiscordApi();
    for (const member of listedMembers(10_001)) discord.members.set(member.userId, member);
    const roster = new MemberRoster(discord, deps.subjects);
    expect(await roster.roster()).toMatchObject({ complete: false });
    expect((await roster.roster()).members).toHaveLength(10_000);
    expect((await roster.search("member10000", 5)).map((member) => member.id)).toEqual(["400000000000010000"]);
  });
});

describe("read-only members", () => {
  test("the grants page is for admins only", async () => {
    const guardEvent = (viewer: Viewer) => ({
      locals: { viewerGate: async () => ({ kind: "viewer", viewer }) } as unknown as App.Locals,
      url: new URL("http://x/dashboard/grants"),
      request: new Request("http://x/dashboard/grants"),
    });
    await expect(requireAdminViewer(guardEvent(await viewerFor(MEMBER)))).rejects.toMatchObject({ status: 403 });
    expect(await requireAdminViewer(guardEvent(owner))).toBe(owner);
  });

  test("the users page hides grant links and revocation; members get a history link on their own row only", async () => {
    const member = { ...(await viewerFor(MEMBER)), permissions: [] };
    const memberLogin = await signIn(h, MEMBER);
    const data = await usersPage(deps, params(), member);
    expect(data.canRevoke).toBe(false);
    expect(data.rows.every((row) => row.grantHref === null && row.historyHref === null)).toBe(true);
    const asReader = { ...member, permissions: ["discord:read" as const] };
    expect(await userRow(memberLogin.userId, "", asReader)).toMatchObject({
      grantHref: null,
      historyHref: "/dashboard/calls?permission=discord%3Aread",
    });
    const others = (await usersPage(deps, params(), asReader)).rows.filter((row) => row.userId !== memberLogin.userId);
    expect(others.every((row) => row.historyHref === null)).toBe(true);
  });

  test("audit details offer no revert to non-admins", async () => {
    const parent = h.notion.addPage({ title: "Read-only root" });
    const created = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Viewed", request: {} });
    const reader = { ...(await viewerFor(MEMBER)), canViewAudit: true };
    expect((await auditDetail(deps, String(created.auditId), reader))?.revert).toBeNull();
    expect((await auditDetail(deps, String(created.auditId), owner))?.revert).toEqual({ state: "ready" });
  });

  test("every mutation is refused with 403 and changes nothing", async () => {
    const member = { ...(await viewerFor(MEMBER)), canViewAudit: true };
    const before = await h.server.grants.listGrants();
    expect(ADMIN_ONLY).toEqual({ kind: "error", message: "この操作は管理者だけが行えます。", status: 403 });

    expect(await createGrant(deps, form({ permission: "admin", subjectType: "user", subjectId: MEMBER }), member)).toEqual(ADMIN_ONLY);
    await h.server.grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    const withGrant = await h.server.grants.listGrants();
    expect(await deleteGrant(deps, form({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD }), member)).toEqual(
      ADMIN_ONLY,
    );
    expect(await h.server.grants.listGrants()).toEqual(withGrant);
    await h.server.grants.removeGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    expect(await h.server.grants.listGrants()).toEqual(before);

    const target = await signIn(h, READER);
    expect(await revokeTokens(deps, target.userId, member)).toEqual(ADMIN_ONLY);
    expect(await h.server.auth.api.getSession({ headers: new Headers({ cookie: target.cookie }) })).not.toBeNull();
    expect((await userRow(target.userId)).revoked).toBeNull();

    const parent = h.notion.addPage({ title: "Protected root" });
    const created = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Protected", request: {} });
    expect(await revertAudit(deps, String(created.auditId), form({ confirm: "yes" }), member)).toEqual({
      result: ADMIN_ONLY,
      conflict: false,
    });
    expect((await h.server.notionAudit.getAudit(created.auditId))!.revertedAt).toBeNull();
    expect(h.notion.pages.get(created.pageId)!.in_trash).toBeFalsy();
  });
});

describe("sign-in and sign-out", () => {
  const callbackOf = async (query: string) => (await signInPage(deps, new URL(`http://x/sign-in${query}`))).callbackURL;

  test("plain sign-in honours a safe next path only and lands on the dashboard", async () => {
    expect(await callbackOf("?next=%2Fdashboard%2Fusers")).toBe("/dashboard/users");
    expect(await callbackOf("")).toBe("/dashboard");
    expect(await callbackOf("?next=%2F%2Fevil.example")).toBe("/dashboard");
    expect(await callbackOf("?next=%2F%5Cevil.example")).toBe("/dashboard");
    expect(await callbackOf("?next=https%3A%2F%2Fevil.example")).toBe("/dashboard");
  });

  test("an OAuth sign-in keeps resuming the authorization flow", async () => {
    const page = await signInPage(deps, new URL("http://x/sign-in?client_id=x&ba_param=client_id&sig=abc&next=%2Fdashboard%2Fusers"));
    expect(page.callbackURL).toBe("/");
    expect(page.oauthQuery).toBe("client_id=x&ba_param=client_id&sig=abc");
    // The provider refuses the forged signature, so the client is shown by its id.
    expect(page.clientName).toBe("x");
  });

  test("the sign-in page names the server, and the client only while resuming an OAuth flow", async () => {
    const plain = await signInPage(deps, new URL("http://x/sign-in"));
    expect(plain).toMatchObject({
      heading: "Test Guild の MCP",
      clientName: null,
      endpoint: "/api/auth/sign-in/social",
      errorCallbackURL: "/sign-in/error",
    });

    const clientId = await registerClient(h);
    const res = await authorize(h, clientId, "");
    const location = new URL(res.headers.get("location")!, h.base);
    expect(location.pathname).toBe("/sign-in");
    expect((await signInPage(deps, location)).clientName).toBe("E2E CLI");
  });

  test("sign-in errors explain how to retry", () => {
    expect(signInErrorMessage("access_denied")).toBe("Discord でのログインがキャンセルされました。");
    expect(signInErrorMessage("boom")).toBe("ログインに失敗しました（boom）。MCP クライアントで接続し直してください。");
  });

  test("sign-out ends the session", async () => {
    const { cookie } = await signIn(h, ADMIN_MEMBER);
    expect((await gate(cookie)).kind).toBe("viewer");
    const result = await signOut(deps, new Headers({ cookie }), "");
    expect(result.location).toBe("/sign-in?next=%2Fdashboard");
    expect(result.cookies).toContainEqual({
      name: "better-auth.session_token",
      value: "",
      options: expect.objectContaining({ path: "/", maxAge: 0, httpOnly: true, secure: false, sameSite: "lax" }),
    });
    expect((await gate(cookie)).kind).toBe("signed-out");
  });

  test("switching accounts from the consent page returns to sign-in only", async () => {
    const resume = "/sign-in?client_id=x&ba_param=client_id&sig=abc";
    const out = async (next: string) => (await signOut(deps, new Headers({ cookie: (await signIn(h, READER)).cookie }), next)).location;
    expect(await out(resume)).toBe(resume);
    expect(await out("https://evil.example/sign-in?x")).toBe("/sign-in?next=%2Fdashboard");
    expect(await out("/dashboard/users")).toBe("/sign-in?next=%2Fdashboard");
  });
});

describe("consent", () => {
  test("tells callbacks on this device from websites, and metadata-document clients from self-named ones", () => {
    expect(redirectTarget("http://127.0.0.1:5555/cb")).toEqual({ origin: "http://127.0.0.1:5555", local: true });
    expect(redirectTarget("cursor://anysphere.cursor-retrieval/oauth")).toEqual({
      origin: "cursor://anysphere.cursor-retrieval",
      local: true,
    });
    expect(redirectTarget("https://app.example.com/cb")).toEqual({ origin: "https://app.example.com", local: false });
    expect(redirectTarget("http://evil.example/cb")).toEqual({ origin: "http://evil.example", local: false });
    expect(redirectTarget(null)).toBeNull();
    expect(metadataHost("https://claude.ai/oauth/mcp-client.json")).toBe("claude.ai");
    expect(metadataHost("Yx3kLq9")).toBeNull();
    expect(metadataHost("http://client.example/metadata.json")).toBeNull();
  });

  test("lists only the signed-in user's effective permissions", async () => {
    await h.server.grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: READER });
    const page = await consentFor(READER);
    expect(page.clientName).toBe("E2E CLI");
    expect(page.redirect).toEqual({ origin: new URL(REDIRECT_URI).origin, local: true });
    expect(page.verifiedHost).toBeNull();
    expect(page.account).toMatchObject({ name: "Reader", username: "reader" });
    expect(page.guildName).toBe("Test Guild");
    expect(page.switchNext.startsWith("/sign-in?")).toBe(true);
    expect(page.features).toEqual([
      { permission: "notion:read", title: "Notion 閲覧", description: "共有されたページ・データベースの検索と閲覧" },
    ]);
  });

  test("admins see every capability including the admin UI", async () => {
    const page = await consentFor(OWNER_ID);
    expect(page.features.map((feature) => feature.title)).toEqual(["Discord 閲覧", "Notion 閲覧", "Notion 編集", "管理画面"]);
  });

  test("a member without permissions gets an empty list", async () => {
    expect((await consentFor(NEWCOMER)).features).toEqual([]);
  });

  test("requests outside the OAuth flow, without a session or from non-members are refused", async () => {
    expect(await consentPage(deps, new URL("http://x/consent"), new Headers())).toMatchObject({ kind: "error", status: 400 });
    const signed = new URL("http://x/consent?client_id=x&ba_param=client_id&sig=abc");
    expect(await consentPage(deps, signed, new Headers())).toMatchObject({ kind: "error", status: 401 });
    const outsider = await signIn(h, OUTSIDER);
    expect(await consentPage(deps, signed, new Headers({ cookie: outsider.cookie }))).toMatchObject({
      kind: "error",
      status: 403,
      title: "アクセスできません",
    });
  });

  test("a membership check that fails says so (503) instead of calling the user a non-member", async () => {
    const signed = new URL("http://x/consent?client_id=x&ba_param=client_id&sig=abc");
    const flaky = await signIn(h, FLAKY);
    expect(await consentPage(deps, signed, new Headers({ cookie: flaky.cookie }))).toMatchObject({
      kind: "error",
      status: 503,
      title: "一時的に確認できません",
    });
    expect(h.errors.at(-1)).toMatchObject({ event: "access_resolution_failed", source: "consent", discordUserId: FLAKY });
  });

  test("display-only lookups that fail unexpectedly are logged, and the page still renders", async () => {
    const failing = { ...deps, directory: { ...deps.directory, fetchGuild: () => Promise.reject(new Error("discord down")) } };
    const page = await signInPage(failing, new URL("http://x/sign-in"));
    expect(page.guildName).toBeNull();
    expect(h.errors.at(-1)).toEqual({ event: "sign_in_lookup_failed", lookup: "guild", error: "discord down" });
  });

  test("the client id comes from the signed query only", async () => {
    const { cookie } = await signIn(h, READER);
    const headers = new Headers({ cookie });
    const unsigned = new URL("http://x/consent?client_id=evil&state=s&ba_param=state&sig=abc");
    expect(await consentPage(deps, unsigned, headers)).toMatchObject({ kind: "error", status: 400 });

    const clientId = await registerClient(h);
    const location = new URL((await authorize(h, clientId, cookie)).headers.get("location")!, h.base);
    expect((await consentPage(deps, location, headers)).kind).toBe("ok");
    const duplicated = new URL(`${location.pathname}?client_id=evil&${location.search.slice(1)}`, h.base);
    expect(await consentPage(deps, duplicated, headers)).toMatchObject({ kind: "error", status: 400 });
  });
});

describe("users", () => {
  test("lists permissions with exact labels, admins as one badge, and marks individual grants", async () => {
    await h.server.grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    await h.server.grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: MEMBER });
    const member = await signIn(h, MEMBER);
    const data = await usersPage(deps, params(), owner);
    expect(data.total).toBe(data.rows.length);
    expect(data.canRevoke).toBe(true);

    const mina = await userRow(member.userId);
    expect(mina).toMatchObject({ displayName: "Mina", username: "mina", roles: { text: "Moderator", title: null } });
    expect(mina.permissions).toEqual([
      { label: "Discord 閲覧", tone: "secondary", title: undefined, individual: false },
      { label: "Notion 閲覧", tone: "secondary", title: "個人に付与", individual: true },
    ]);
    await h.server.grants.createGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    expect((await userRow(member.userId)).permissions).toEqual([
      { label: "Discord 閲覧", tone: "secondary", title: undefined, individual: false },
      // The individual Notion read adds nothing to the role's write: the badge is not marked individual.
      { label: "Notion 閲覧・編集", tone: "secondary", title: undefined, individual: false },
    ]);
    await h.server.grants.removeGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    expect(mina.lastUsed).toBe("—");
    h.server.toolCalls.record({
      discordUserId: MEMBER,
      tool: "discord_read_messages",
      ok: true,
      durationMs: 5,
      createdAt: new Date("2026-10-15T03:04:00Z"),
    });
    h.server.toolCalls.record({
      discordUserId: MEMBER,
      tool: "discord_read_messages",
      ok: true,
      durationMs: 5,
      createdAt: new Date("2026-10-14T00:00:00Z"),
    });
    expect((await userRow(member.userId)).lastUsed).toBe("10/15 12:04");

    const ownerRow = await userRow(ownerUserId);
    expect(ownerRow.permissions).toEqual([{ label: "管理者", tone: "dark", title: undefined, individual: false }]);
    expect(ownerRow.roles.text).toBe("管理者");

    await h.server.grants.removeGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
  });

  test("row menu links grant and history pages of the Discord account", async () => {
    const member = await signIn(h, MEMBER);
    const row = await userRow(member.userId);
    expect(row.grantHref).toBe(`/dashboard/grants?subject=user%3A${MEMBER}`);
    expect(row.historyHref).toBe(`/dashboard/calls?permission=discord%3Aread&user=${MEMBER}`);
  });

  test("search filters by name, @username and id", async () => {
    const member = await signIn(h, MEMBER);
    for (const query of ["mina", "@mina", MEMBER]) {
      const data = await usersPage(deps, params(`q=${encodeURIComponent(query)}`), owner);
      expect(data.rows.map((row) => row.userId)).toEqual([member.userId]);
      expect(data.total).toBe(1);
    }
    const none = await usersPage(deps, params("q=nobody-matches"), owner);
    expect(none.rows).toEqual([]);
    expect(none.empty).toBe("「nobody-matches」に一致するユーザーはいません。");
  });
});

describe("user search scan cap", () => {
  test(`a search only scans the newest ${USER_SEARCH_SCAN_LIMIT} logins`, async () => {
    const login = (index: number, name: string): LoginUser => ({
      userId: `login-${index}`,
      name,
      discordUserId: null,
      lastLoginAt: null,
      revokedAt: null,
    });
    // Newest first, as LoginUserStore.list returns them.
    const logins = Array.from({ length: USER_SEARCH_SCAN_LIMIT + 5 }, (_, index) => login(index, `user ${index}`));
    logins[3] = login(3, "needle recent");
    logins[USER_SEARCH_SCAN_LIMIT + 2] = login(USER_SEARCH_SCAN_LIMIT + 2, "needle old");
    const queries: Array<{ limit: number; offset: number }> = [];
    const fakeDeps = {
      directory: { fetchGuild: async () => makeGuild() },
      grants: { listGrants: async () => [] },
      users: {
        count: async () => logins.length,
        list: async (query: { limit: number; offset: number }) => {
          queries.push(query);
          return logins.slice(query.offset, query.offset + query.limit);
        },
      },
      resolver: { resolve: async () => Promise.reject(new Error("unlinked logins are not resolved")) },
      usage: { lastUsed: () => new Map() },
      logError: () => {},
      tools: [],
    } as unknown as Pick<DashboardDeps, "directory" | "grants" | "users" | "resolver" | "usage" | "logError" | "tools">;

    const found = await usersPage(fakeDeps, params("q=needle"), owner);
    expect(queries).toEqual([{ limit: USER_SEARCH_SCAN_LIMIT, offset: 0 }]);
    expect(found.rows.map((row) => row.displayName)).toEqual(["needle recent"]);
    expect(found.total).toBe(1);

    const all = await usersPage(fakeDeps, params("q=user"), owner);
    expect(all.total).toBe(USER_SEARCH_SCAN_LIMIT - 1);
    expect(all.nextHref).toBe("/dashboard/users?q=user&page=2");
  });
});

describe("token revocation", () => {
  test("revoking rejects earlier tokens immediately; a new login works", async () => {
    await h.server.grants.createGrant({ permission: "discord:read", subjectType: "user", subjectId: MEMBER });
    const login = await signIn(h, MEMBER);
    const clientId = await registerClient(h);
    const before = await issueTokens(h, clientId, login.cookie);
    const listTools = (token: string) => mcpCall(h, token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect((await listTools(before.access_token)).status).toBe(200);

    expect(await revokeTokens(deps, login.userId, owner)).toEqual({ kind: "ok", message: `user-${MEMBER} のトークンを失効しました。` });
    expect((await userRow(login.userId)).revoked).toMatch(/^失効 \d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    expect(h.events.at(-1)).toMatchObject({ event: "tokens_revoked", userId: login.userId, by: OWNER_ID });

    const rejected = await listTools(before.access_token);
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(rejected.headers.get("www-authenticate")).toContain(`resource_metadata="${h.base}/.well-known/oauth-protected-resource/mcp"`);
    expect(rejected.json).toEqual({ error: "invalid_token", error_description: "The access token has been revoked. Sign in again." });
    expect((await refreshTokens(h, clientId, before.refresh_token!)).status).not.toBe(200);
    expect(await h.server.auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) })).toBeNull();

    // `iat` has one-second resolution; tokens from the revocation's second stay rejected.
    await Bun.sleep(1000 - (Date.now() % 1000) + 20);
    const after = await issueTokens(h, clientId, await newSessionCookie(h, login.userId));
    expect((await listTools(after.access_token)).status).toBe(200);
  });

  test("an unknown user is reported", async () => {
    expect(await revokeTokens(deps, "nope", owner)).toEqual({ kind: "error", message: "ユーザーが見つかりません。" });
  });
});

describe("audit log", () => {
  test("lists entries with filters", async () => {
    const parent = h.notion.addPage({ title: "Audit root" });
    const created = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Listed", request: { title: "Listed" } });

    const list = await auditList(deps, params(), owner);
    const row = list.rows.find((candidate) => candidate.id === created.auditId);
    expect(row).toMatchObject({
      href: `/dashboard/audit/${created.auditId}`,
      operation: "ページを作成",
      user: { name: "Mina" },
      title: "Listed",
    });
    expect(row?.targetUrl).toBeString();
    expect(row?.badge).toBeNull();
    expect(row?.meta).toMatch(/^ページを作成 · Mina · \d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(list.userOptions).toContainEqual({ value: MEMBER, label: "Mina" });
    expect(list.range).toMatch(/^\d+ 件中 1–\d+ 件$/);

    expect(
      (await auditList(deps, params("operation=append_content"), owner)).rows.some((candidate) => candidate.id === created.auditId),
    ).toBe(false);
    await expect(
      writes.editContent(MEMBER_ACTOR, { pageId: parent.id, edits: [{ old_str: "missing", new_str: "x" }], request: {} }),
    ).rejects.toThrow();
    const failed = await auditList(deps, params("status=failed"), owner);
    expect(failed.rows.some((candidate) => candidate.id === created.auditId)).toBe(false);
    expect(failed.rows[0]?.badge).toEqual({ label: "失敗", tone: "destructive" });
    expect(failed.filters.status).toBe("failed");
    expect((await auditList(deps, params("user=abc"), owner)).error).toBe("ユーザー ID は Discord の数値 ID で指定してください。");
    expect((await auditList(deps, params(`user=${STRANGER}`), owner)).userOptions).toContainEqual({ value: STRANGER, label: STRANGER });
  });

  test("a page past the end links back to the last page", async () => {
    const parent = h.notion.addPage({ title: "Pager root" });
    await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Paged", request: {} });
    const { total } = await auditList(deps, params("status=ok"), owner);
    const lastPage = Math.ceil(total / 50);
    const past = await auditList(deps, params(`status=ok&page=${lastPage + 5}`), owner);
    expect(past.rows).toEqual([]);
    expect(past.range).toBeNull();
    expect(past.nextHref).toBeNull();
    expect(past.prevHref).toBe(lastPage > 1 ? `/dashboard/audit?status=ok&page=${lastPage}` : "/dashboard/audit?status=ok");
  });

  test("details show the change and offer a revert", async () => {
    const parent = h.notion.addPage({ title: "Detail root" });
    const created = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Detailed", request: { title: "Detailed" } });
    const detail = (await auditDetail(deps, String(created.auditId), owner))!;
    expect(detail).toMatchObject({ id: created.auditId, operation: "ページを作成", revert: { state: "ready" } });
    expect(detail.summary).toMatch(/^Mina が \d{2}\/\d{2} \d{2}:\d{2} に「Detailed」を作成しました。$/);
    expect(detail.change).toMatchObject({ kind: "created", title: "Detailed" });
    expect(detail.details.comment).toEqual({ kind: "posted" });
  });

  test("content writes render their stored hunks as a diff", async () => {
    const page = h.notion.addPage({ title: "Diff page", markdown: "Intro\nOld line\nOutro" });
    const edited = await writes.editContent(MEMBER_ACTOR, {
      pageId: page.id,
      edits: [{ old_str: "Old line", new_str: "New line" }],
      request: {},
    });
    const detail = (await auditDetail(deps, String(edited.auditId), owner))!;
    expect(detail.summary).toEndWith("「Diff page」の本文を編集しました。");
    expect(detail.change).toEqual({
      kind: "diff",
      meta: "1 か所 · −1 +1",
      lines: [
        { kind: "del", text: "− Old line" },
        { kind: "add", text: "+ New line" },
      ],
    });
  });

  test("failed writes show their error and no revert", async () => {
    const page = h.notion.addPage({ title: "Broken page", markdown: "Intro" });
    await expect(
      writes.editContent(MEMBER_ACTOR, {
        pageId: page.id,
        edits: [{ old_str: "absent", new_str: "x" }],
        request: { edits: [{ old_str: "absent", new_str: "x" }] },
      }),
    ).rejects.toThrow();
    const { rows } = await h.server.notionAudit.listAudit({ status: "failed", limit: 1 });
    const detail = (await auditDetail(deps, String(rows[0]!.id), owner))!;
    expect(detail.badges).toEqual([{ label: "失敗", tone: "destructive" }]);
    expect(detail.details.error).toContain("No matches found");
    expect(detail.details.note).toBeNull();
    expect(detail.summary).toEndWith("「Broken page」の本文の編集に失敗しました。");
    expect(detail.change).toMatchObject({
      kind: "diff",
      lines: [
        { kind: "del", text: "− absent" },
        { kind: "add", text: "+ x" },
      ],
    });
    expect(detail.revert).toBeNull();
  });

  test("revert requires the confirmation, then links both rows", async () => {
    const parent = h.notion.addPage({ title: "Revert root" });
    const created = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Undo me", request: {} });
    const id = String(created.auditId);

    expect(await revertAudit(deps, id, form({}), owner)).toEqual({
      result: { kind: "error", message: "確認のチェックを入れてから取り消してください。" },
      conflict: false,
    });
    expect((await h.server.notionAudit.getAudit(created.auditId))!.revertedAt).toBeNull();

    expect(await revertAudit(deps, id, form({ confirm: "yes" }), owner)).toEqual({
      result: { kind: "ok", message: "取り消しました。" },
      conflict: false,
    });
    const row = (await h.server.notionAudit.getAudit(created.auditId))!;
    expect(row.revertedBy).toBe(OWNER_ID);
    expect(h.notion.pages.get(created.pageId)!.in_trash).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ event: "audit_revert", auditId: created.auditId, ok: true });

    const detail = (await auditDetail(deps, id, owner))!;
    expect(detail.revert).toEqual({
      state: "reverted",
      revert: { id: row.revertAuditId!, href: `/dashboard/audit/${row.revertAuditId}` },
      note: null,
    });
    expect(detail.badges.map((badge) => badge.label)).toEqual(["成功", "取り消し済み"]);

    const revertRow = (await auditDetail(deps, String(row.revertAuditId), owner))!;
    expect(revertRow.change).toEqual({ kind: "revert", of: { id: created.auditId, href: `/dashboard/audit/${created.auditId}` } });
    expect(revertRow.revert).toBeNull();
    const reverted = (await auditList(deps, params("status=reverted"), owner)).rows.find((candidate) => candidate.id === created.auditId);
    expect(reverted?.badge).toEqual({ label: "取り消し済み", tone: "secondary" });
    const revertListRow = (await auditList(deps, params(), owner)).rows.find((candidate) => candidate.id === row.revertAuditId);
    expect(revertListRow?.meta).toStartWith(`#${created.auditId} を取り消し · `);
    expect(await revertAudit(deps, "99999", form({ confirm: "yes" }), owner)).toBeNull();
  });

  test("a revert of a page edited afterwards is refused and left to be fixed by hand", async () => {
    const parent = h.notion.addPage({ title: "Conflict root", markdown: "Intro" });
    const appended = await writes.appendContent(MEMBER_ACTOR, { pageId: parent.id, content: "mine", request: {} });
    h.notion.setMarkdown(parent.id, "Intro\nmine\nlater edit");
    const id = String(appended.auditId);

    const attempts: Array<Record<string, string>> = [{ confirm: "yes" }, { confirm: "yes", force: "true" }];
    for (const fields of attempts) {
      expect(await revertAudit(deps, id, form(fields), owner)).toEqual({ result: { kind: "warn", message: null }, conflict: true });
    }
    expect(h.notion.markdown.get(parent.id)).toBe("Intro\nmine\nlater edit");
    expect((await h.server.notionAudit.getAudit(appended.auditId))!.revertedAt).toBeNull();
    const detail = (await auditDetail(deps, id, owner))!;
    expect(detail.details.targetUrl).toBeString();
    expect(detail.change).toMatchObject({ kind: "diff", lines: [{ kind: "add", text: "+ mine" }] });
  });

  test("without Notion a revert is not offered", async () => {
    const parent = h.notion.addPage({ title: "Disabled root" });
    const created = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Kept", request: {} });
    const detail = await auditDetail({ ...deps, audit: new NotionAuditService(store, null) }, String(created.auditId), owner);
    expect(detail?.revert).toEqual({ state: "disabled" });
  });

  test("a pending write reads as in progress", async () => {
    const pending = await store.insert({
      discordUserId: MEMBER,
      discordDisplayName: "Mina",
      operation: "archive_page",
      targetTitle: "Old notes",
      request: {},
      status: "pending",
    });
    const detail = (await auditDetail(deps, String(pending.id), owner))!;
    expect(detail.summary).toMatch(/^Mina が \d{2}\/\d{2} \d{2}:\d{2} に「Old notes」をアーカイブしています。$/);
    expect(detail.operation).toBe("ページをアーカイブ");
    expect(detail.revert).toBeNull();
  });

  test("writers see only their own writes; admins see everyone's", async () => {
    const parent = h.notion.addPage({ title: "Scope root" });
    const mine = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Mine", request: {} });
    const theirs = await writes.createPage(
      { discordUserId: STRANGER, displayName: "Stranger", username: "stranger" },
      {
        parentId: parent.id,
        title: "Theirs",
        request: {},
      },
    );
    const writer = { isAdmin: false, discordUserId: MEMBER, permissions: ["notion:read" as const, "notion:write" as const] };

    const own = await auditList(deps, params(`user=${STRANGER}`), writer);
    expect(own.rows.map((row) => row.id)).toContain(mine.auditId);
    expect(own.rows.every((row) => row.user.id === MEMBER)).toBe(true);
    expect(own).toMatchObject({ canFilterUsers: false, userOptions: [], filters: { user: "" } });
    expect(await auditDetail(deps, String(mine.auditId), writer)).not.toBeNull();
    expect(await auditDetail(deps, String(theirs.auditId), writer)).toBeNull();

    const all = await auditList(deps, params(), owner);
    expect(all.rows.map((row) => row.id)).toEqual(expect.arrayContaining([mine.auditId, theirs.auditId]));
    expect(all.canFilterUsers).toBe(true);
    expect(await auditDetail(deps, String(theirs.auditId), owner)).not.toBeNull();
  });

  test("an interrupted write says its outcome is unknown and offers no revert", async () => {
    const stuck = await store.insert({
      discordUserId: MEMBER,
      discordDisplayName: "Mina",
      operation: "create_page",
      targetTitle: "Draft",
      request: {},
      status: "pending",
    });
    await h.server.notionAudit.markInterruptedWrites(new Date(Date.now() + 11 * 60_000));
    const detail = (await auditDetail(deps, String(stuck.id), owner))!;
    expect(detail.badges).toEqual([{ label: "中断", tone: "warn" }]);
    expect(detail.summary).toEndWith("「Draft」を作成しようとしましたが、途中で中断しました（反映されたかは不明です）。");
    expect(detail.revert).toBeNull();
    const listed = await auditList(deps, params("status=interrupted"), owner);
    expect(listed.rows.map((row) => row.id)).toContain(stuck.id);
    expect(listed.rows.every((row) => row.badge?.label === "中断")).toBe(true);
  });

  test("a row the service would refuse shows why instead of a revert button", async () => {
    const parent = h.notion.addPage({ title: "Unreadable root" });
    const created = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Broken", request: {} });
    await overwriteAuditRow(h.server.database.db, created.auditId, { result: { url: "https://example.invalid" } });
    expect((await auditDetail(deps, String(created.auditId), owner))?.revert).toEqual({
      state: "unavailable",
      reason: "記録の形式を読み取れないため、自動では取り消せません。",
    });
  });

  test("stored notes are shown in Japanese; unknown kinds generically", () => {
    const note: RevertNote = {
      kind: "properties_partial",
      restored: ["Count"],
      skipped: [{ name: "Files", refusal: { kind: "hosted_files", files: ["a.png"] } }],
    };
    expect(auditNoteText(note)).toBe(
      "「Count」を戻しました。「Files」（Notion にアップロードされたファイル（a.png）は API で設定し直せません）は戻せませんでした。",
    );
    expect(auditNoteText({ kind: "revert_blocked", blocker: "concurrent_edit" })).toBe(
      "書き込みは反映しましたが、自動では取り消せません: 同時に別の人がページを編集しており、取り消すとその編集まで消えてしまいます。",
    );
    expect(auditNoteText({ kind: "from_a_newer_version" })).toBe("この注記は、より新しいバージョンで記録されたため表示できません。");
    expect(auditNoteText(null)).toBeNull();
  });
});
