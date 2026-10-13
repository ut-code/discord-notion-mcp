import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN_ONLY, checkViewer, signInRedirect, type Viewer } from "../../src/lib/server/dashboard/access";
import { auditDetail, auditList, revertAudit } from "../../src/lib/server/dashboard/audit";
import type { DashboardDeps } from "../../src/lib/server/dashboard/deps";
import { createGrant, deleteGrant, grantsPage } from "../../src/lib/server/dashboard/grants";
import { overview } from "../../src/lib/server/dashboard/overview";
import { consentPage, NOT_MEMBER, signInErrorMessage, signInPage, signOut } from "../../src/lib/server/dashboard/session";
import { revokeTokens, USER_SEARCH_SCAN_LIMIT, usersPage, type UserTableRow } from "../../src/lib/server/dashboard/users";
import type { LoginUser } from "../../src/lib/server/auth/users";
import { ADMINISTRATOR } from "../../src/lib/server/discord/permissions";
import type { Actor } from "../../src/lib/server/notion/changes/attribution";
import { NotionAuditStore } from "../../src/lib/server/notion/changes/audit-store";
import { NotionWriteService } from "../../src/lib/server/notion/changes/write-service";
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
  deps = h.composed.dashboard;
  ownerUserId = (await signIn(h, OWNER_ID)).userId;
  owner = await adminFor(OWNER_ID);
  store = new NotionAuditStore(h.composed.database.db);
  writes = new NotionWriteService(h.notion, store);
});

afterAll(() => {
  h?.stop();
});

describe("dashboard access control", () => {
  test("without a session the sign-in redirect keeps the requested page", async () => {
    expect(await checkViewer(deps, new Headers())).toEqual({ kind: "signed-out" });
    expect(signInRedirect(new URL("http://x/dashboard"), "GET")).toBe("/sign-in?next=%2Fdashboard");
    expect(signInRedirect(new URL("http://x/dashboard/audit?status=ok"), "GET")).toBe(`/sign-in?next=${encodeURIComponent("/dashboard/audit?status=ok")}`);
    expect(signInRedirect(new URL("http://x/dashboard/grants?/create"), "POST")).toBe("/sign-in?next=%2Fdashboard");
  });

  test("non-admin members are read-only viewers; non-members are denied with 403", async () => {
    const member = await viewerFor(MEMBER);
    expect(member).toMatchObject({ discordUserId: MEMBER, roleLabel: "メンバー", isAdmin: false, canViewAudit: false });
    const outsider = await gate((await signIn(h, OUTSIDER)).cookie);
    expect(outsider).toEqual({ kind: "denied", status: 403, ...NOT_MEMBER });
  });

  test("the write history needs notion:read (or admin)", async () => {
    expect((await viewerFor(READER)).canViewAudit).toBe(false);
    await h.composed.grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: READER });
    expect(await viewerFor(READER)).toMatchObject({ isAdmin: false, canViewAudit: true });
    await h.composed.grants.removeGrant({ permission: "notion:read", subjectType: "user", subjectId: READER });
    expect(owner.canViewAudit).toBe(true);
  });

  test("a failing membership check yields 503", async () => {
    expect(await gate((await signIn(h, FLAKY)).cookie)).toMatchObject({ kind: "denied", status: 503, title: "一時的に確認できません" });
  });

  test("owner, ADMINISTRATOR role holders and explicit admin grants are admins", async () => {
    await h.composed.grants.createGrant({ permission: "admin", subjectType: "user", subjectId: GRANTED_ADMIN });
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
      isAdmin: true,
      canViewAudit: true,
    });
  });

  test("an unknown audit id is not found", async () => {
    expect(await auditDetail(deps, "99999", owner)).toBeNull();
    expect(await auditDetail(deps, "abc", owner)).toBeNull();
  });
});

describe("overview", () => {
  test("links failures to the write history and offers granting to admins", async () => {
    const data = await overview(deps, owner);
    expect(data.failuresHref).toBe("/dashboard/audit?status=failed");
    expect(data.canGrant).toBe(true);
    expect(data.recent).toBeArray();
  });

  test("the failure count covers unreverted failed writes of the last 7 days", async () => {
    expect((await overview(deps, owner)).recentFailures).toBe(0);
    await store.insert({
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
      discordUserId: MEMBER,
      discordDisplayName: "Mina",
      operation: "archive_page",
      request: {},
      status: "failed",
      error: "old failure",
    });
    expect((await overview(deps, owner)).recentFailures).toBe(0);

    const page = h.notion.addPage({ title: "Failing page", markdown: "Intro" });
    await expect(writes.editContent(MEMBER_ACTOR, { pageId: page.id, edits: [{ old_str: "missing", new_str: "x" }], request: {} })).rejects.toThrow();
    const data = await overview(deps, owner);
    expect(data.recentFailures).toBe(1);
    expect(data.recent?.[0]).toMatchObject({ operation: "本文を編集", title: "Failing page", badge: { label: "失敗", tone: "destructive" } });
  });

  test("members without notion:read see neither failures nor recent writes", async () => {
    const member = await viewerFor(MEMBER);
    expect(await overview(deps, member)).toMatchObject({ recentFailures: 0, recent: null, canGrant: false });
    const reader = { ...member, canViewAudit: true };
    const data = await overview(deps, reader);
    expect(data.recentFailures).toBe(1);
    expect(data.canGrant).toBe(false);
  });
});

describe("grants", () => {
  test("adds a role grant, reports duplicates, and deletes it", async () => {
    const fields = { permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD };
    expect(await createGrant(deps, form(fields), owner)).toEqual({ kind: "ok", message: "ロール「Moderator」に「Discord 読み取り」を付与しました。" });
    const stored = (await h.composed.grants.listGrants()).find((grant) => grant.subjectId === ROLE_MOD);
    expect(stored).toMatchObject({ permission: "discord:read", subjectType: "role", createdBy: OWNER_ID });
    expect(h.events).toContainEqual({ event: "grant_added", permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD, by: OWNER_ID });
    const row = (await grantsPage(deps, params(), owner)).rows.find((candidate) => candidate.key === `role:${ROLE_MOD}:discord:read`);
    expect(row?.subject).toMatchObject({ name: "@Moderator", color: "#3498db", secondary: "ロール" });
    expect(row?.remove).toMatchObject({
      label: "@Moderator の Discord 読み取りを削除",
      menuLabel: "@Moderator の Discord 読み取りの操作",
      confirm: "@Moderator の Discord 読み取りを削除しますか？",
    });

    expect(await createGrant(deps, form(fields), owner)).toMatchObject({ kind: "warn", message: "ロール「Moderator」には既に「Discord 読み取り」が付与されています。" });

    expect(await deleteGrant(deps, form(fields), owner)).toEqual({ kind: "ok", message: "@Moderator から「Discord 読み取り」を削除しました。" });
    expect((await h.composed.grants.listGrants()).some((grant) => grant.subjectId === ROLE_MOD)).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ event: "grant_removed", subjectId: ROLE_MOD });
    expect(await deleteGrant(deps, form(fields), owner)).toMatchObject({ kind: "warn", message: "この付与は既に削除されています。" });
  });

  test("the grant form sends roleId or userId depending on the target", async () => {
    const byRole = await createGrant(deps, form({ permission: "notion:read", subjectType: "role", roleId: ROLE_MOD, userId: MEMBER }), owner);
    expect(byRole.message).toBe("ロール「Moderator」に「Notion 読み取り」を付与しました。");
    const byUser = await createGrant(deps, form({ permission: "notion:read", subjectType: "user", roleId: ROLE_MOD, userId: READER }), owner);
    expect(byUser.message).toBe("ユーザー「Reader」に「Notion 読み取り」を付与しました。");
    expect(await createGrant(deps, form({ permission: "notion:read", subjectType: "user", roleId: ROLE_MOD }), owner)).toEqual({
      kind: "error",
      message: "ユーザーを選んでください。",
    });
    await h.composed.grants.removeGrant({ permission: "notion:read", subjectType: "role", subjectId: ROLE_MOD });
    await h.composed.grants.removeGrant({ permission: "notion:read", subjectType: "user", subjectId: READER });
  });

  test("rejects invalid snowflakes, unknown permissions and integration roles", async () => {
    const before = (await h.composed.grants.listGrants()).length;
    expect((await createGrant(deps, form({ permission: "notion:read", subjectType: "user", subjectId: "12ab" }), owner)).message).toContain(
      "Discord の ID（15〜22 桁の数字）ではありません",
    );
    expect(await createGrant(deps, form({ permission: "root", subjectType: "user", subjectId: MEMBER }), owner)).toEqual({ kind: "error", message: "不明な権限です。" });
    expect(await createGrant(deps, form({ permission: "notion:read", subjectType: "team", subjectId: MEMBER }), owner)).toEqual({
      kind: "error",
      message: "対象の種類が不正です。",
    });
    expect((await createGrant(deps, form({ permission: "notion:read", subjectType: "role", subjectId: ROLE_BOT }), owner)).message).toContain("ロールを選んでください");
    expect((await h.composed.grants.listGrants()).length).toBe(before);
  });

  test("user grants show resolved names and roles; the role picker excludes integration roles", async () => {
    for (const subjectId of [MEMBER, STRANGER, "399999999999999999"]) {
      await createGrant(deps, form({ permission: "notion:read", subjectType: "user", subjectId }), owner);
    }
    const data = await grantsPage(deps, params(), owner);
    const subjects = data.rows.map((row) => row.subject);
    expect(subjects).toContainEqual(expect.objectContaining({ name: "Mina", secondary: "@mina · Moderator", title: `Discord ID ${MEMBER}` }));
    expect(subjects).toContainEqual(expect.objectContaining({ name: "Stranger", secondary: "@stranger · 非メンバー" }));
    expect(subjects).toContainEqual(expect.objectContaining({ name: "399999999999999999", secondary: "不明なユーザー", unknown: true }));
    expect(data.rows.find((row) => row.subject.name === "Mina")?.remove?.label).toBe("Mina の Notion 読み取りを削除");
    expect(data.form?.roles.map((role) => role.name)).toEqual(["Staff", "Moderator", "@everyone"]);
  });

  test("implicit admins are listed as locked rows under すべて and 管理者", async () => {
    const all = await grantsPage(deps, params(), owner);
    expect(all.rows[0]).toMatchObject({
      subject: { name: "@Staff" },
      permissionLabel: "管理者",
      grantedBy: "Discord の Administrator 権限",
      locked: "Discord 側の権限なのでここでは削除できません",
      remove: null,
    });
    expect(all.rows[1]).toMatchObject({ subject: { name: "The Owner" }, grantedBy: "サーバーオーナー", locked: "サーバーオーナーは常に管理者です" });
    expect(all.tabs[0]).toMatchObject({ label: "すべて", count: all.rows.length, active: true });

    const admins = await grantsPage(deps, params("filter=admin"), owner);
    expect(admins.rows.some((row) => row.grantedBy === "サーバーオーナー")).toBe(true);
    expect(admins.tabs.find((tab) => tab.active)).toMatchObject({ href: "/dashboard/grants?filter=admin", label: "管理者" });
    const readers = await grantsPage(deps, params("filter=notion%3Aread"), owner);
    expect(readers.rows.some((row) => row.grantedBy === "サーバーオーナー")).toBe(false);
    expect(readers.rows.some((row) => row.subject.secondary === "@mina · Moderator")).toBe(true);
    expect(readers.form?.permission).toBe("notion:read");
  });

  test("individual grants already provided by a role or by admin status are flagged", async () => {
    await h.composed.grants.createGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    await h.composed.grants.createGrant({ permission: "notion:write", subjectType: "user", subjectId: MEMBER });
    await h.composed.grants.createGrant({ permission: "discord:read", subjectType: "user", subjectId: ADMIN_MEMBER });
    const badges = (await grantsPage(deps, params(), owner)).rows.flatMap((row) => (row.redundancy ? [row.redundancy] : []));
    expect(badges).toContainEqual({
      label: "@Moderator で付与済み",
      tone: "warn",
      title: "この権限は @Moderator ロールで既に付与されているため、この個人付与は効果がありません",
    });
    expect(badges.map((badge) => badge.label)).toContain("管理者で付与済み");

    await h.composed.grants.removeGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_MOD });
    await h.composed.grants.removeGrant({ permission: "notion:write", subjectType: "user", subjectId: MEMBER });
    await h.composed.grants.removeGrant({ permission: "discord:read", subjectType: "user", subjectId: ADMIN_MEMBER });
    expect((await grantsPage(deps, params(), owner)).rows.some((row) => row.redundancy)).toBe(false);
  });

  test("member search lists matches; a preselected user labels the submit button", async () => {
    const search = await grantsPage(deps, params("q=min&permission=notion%3Awrite"), owner);
    expect(search.form).toMatchObject({ permission: "notion:write", subjectType: "user", query: "min" });
    expect(search.form?.candidates.map((candidate) => candidate.id)).toContain(MEMBER);
    expect(search.form?.permissions.find((option) => option.value === "notion:write")?.hint).toBe(
      "ページの作成・編集・アーカイブができます。すべての操作は記録され、あとから取り消せます。",
    );

    const preselected = await grantsPage(deps, params(`subjectType=user&userId=${MEMBER}&permission=notion%3Awrite`), owner);
    expect(preselected.form?.selectedUserId).toBe(MEMBER);
    expect(preselected.form?.candidates[0]?.id).toBe(MEMBER);
    expect(preselected.form?.submitLabel).toBe("Mina に Notion 書き込みを付与");

    expect((await grantsPage(deps, params(`q=${STRANGER}`), owner)).form?.candidates.map((candidate) => candidate.id)).toEqual([STRANGER]);
    expect((await grantsPage(deps, params("q=zzz"), owner)).form?.candidates).toEqual([]);
    const plain = await grantsPage(deps, params(), owner);
    expect(plain.form).toMatchObject({ subjectType: "role", roleId: ROLE_ADMIN, submitLabel: "@Staff に Discord 読み取りを付与" });
  });
});

describe("read-only members", () => {
  test("the grants page lists grants without the form, delete actions or member search", async () => {
    const member = await viewerFor(MEMBER);
    await h.composed.grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    let searched = false;
    const data = await grantsPage(
      { ...deps, discord: { searchMembers: async () => ((searched = true), []), fetchUser: (id) => deps.discord.fetchUser(id) } },
      params(`q=min&userId=${MEMBER}`),
      member,
    );
    expect(data.form).toBeNull();
    expect(searched).toBe(false);
    expect(data.rows.length).toBe((await grantsPage(deps, params(), owner)).rows.length);
    expect(data.rows.some((row) => row.subject.name === "@Moderator")).toBe(true);
    expect(data.rows.every((row) => row.remove === null)).toBe(true);
    await h.composed.grants.removeGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
  });

  test("the users page hides grant links and revocation, and audit links without notion:read", async () => {
    const member = { ...(await viewerFor(MEMBER)), canViewAudit: false };
    const memberLogin = await signIn(h, MEMBER);
    const data = await usersPage(deps, params(), member);
    expect(data.canRevoke).toBe(false);
    expect(data.rows.every((row) => row.grantHref === null && row.auditHref === null)).toBe(true);
    const asReader = await userRow(memberLogin.userId, "", { ...member, canViewAudit: true });
    expect(asReader).toMatchObject({ grantHref: null, auditHref: `/dashboard/audit?user=${MEMBER}` });
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
    const before = await h.composed.grants.listGrants();
    expect(ADMIN_ONLY).toEqual({ kind: "error", message: "この操作は管理者だけが行えます。", status: 403 });

    expect(await createGrant(deps, form({ permission: "admin", subjectType: "user", subjectId: MEMBER }), member)).toEqual(ADMIN_ONLY);
    await h.composed.grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    const withGrant = await h.composed.grants.listGrants();
    expect(await deleteGrant(deps, form({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD }), member)).toEqual(ADMIN_ONLY);
    expect(await h.composed.grants.listGrants()).toEqual(withGrant);
    await h.composed.grants.removeGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    expect(await h.composed.grants.listGrants()).toEqual(before);

    const target = await signIn(h, READER);
    expect(await revokeTokens(deps, target.userId, member)).toEqual(ADMIN_ONLY);
    expect(await h.composed.auth.api.getSession({ headers: new Headers({ cookie: target.cookie }) })).not.toBeNull();
    expect((await userRow(target.userId)).revoked).toBeNull();

    const parent = h.notion.addPage({ title: "Protected root" });
    const created = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Protected", request: {} });
    const attempts: Array<Record<string, string>> = [{ confirm: "yes" }, { confirm: "yes", force: "true" }];
    for (const fields of attempts) {
      expect(await revertAudit(deps, String(created.auditId), form(fields), member)).toEqual({ result: ADMIN_ONLY, conflict: false });
    }
    expect((await h.composed.notionAudit.getAudit(created.auditId))!.revertedAt).toBeNull();
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
    expect(plain).toMatchObject({ heading: "Test Guild の MCP", clientName: null, endpoint: "/api/auth/sign-in/social", errorCallbackURL: "/sign-in/error" });

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
  test("lists only the signed-in user's effective permissions", async () => {
    await h.composed.grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: READER });
    const page = await consentFor(READER);
    expect(page.clientName).toBe("E2E CLI");
    expect(page.redirectOrigin).toBe(new URL(REDIRECT_URI).origin);
    expect(page.account).toMatchObject({ name: "Reader", username: "reader" });
    expect(page.guildName).toBe("Test Guild");
    expect(page.switchNext.startsWith("/sign-in?")).toBe(true);
    expect(page.features).toEqual([{ permission: "notion:read", title: "Notion 読み取り", description: "共有されたページ・データベースの検索と閲覧" }]);
  });

  test("admins see every capability including the admin UI", async () => {
    const page = await consentFor(OWNER_ID);
    expect(page.features.map((feature) => feature.title)).toEqual(["Discord 読み取り", "Notion 読み取り", "Notion 書き込み", "管理画面"]);
  });

  test("a member without permissions gets an empty list", async () => {
    expect((await consentFor(NEWCOMER)).features).toEqual([]);
  });

  test("requests outside the OAuth flow, without a session or from non-members are refused", async () => {
    expect(await consentPage(deps, new URL("http://x/consent"), new Headers())).toMatchObject({ kind: "error", status: 400 });
    const signed = new URL("http://x/consent?client_id=x&ba_param=client_id&sig=abc");
    expect(await consentPage(deps, signed, new Headers())).toMatchObject({ kind: "error", status: 401 });
    const outsider = await signIn(h, OUTSIDER);
    expect(await consentPage(deps, signed, new Headers({ cookie: outsider.cookie }))).toMatchObject({ kind: "error", status: 403, title: "アクセスできません" });
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
    await h.composed.grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
    await h.composed.grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: MEMBER });
    const member = await signIn(h, MEMBER);
    const data = await usersPage(deps, params(), owner);
    expect(data.total).toBe(data.rows.length);
    expect(data.canRevoke).toBe(true);

    const mina = await userRow(member.userId);
    expect(mina).toMatchObject({ displayName: "Mina", username: "mina", roles: { text: "Moderator", title: null } });
    expect(mina.permissions).toEqual([
      { label: "Discord 読み取り", tone: "secondary", title: undefined, individual: false },
      { label: "Notion 読み取り", tone: "secondary", title: "個人に付与", individual: true },
    ]);
    expect(mina.lastLogin).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);

    const ownerRow = await userRow(ownerUserId);
    expect(ownerRow.permissions).toEqual([{ label: "管理者", tone: "dark", title: undefined, individual: false }]);
    expect(ownerRow.roles.text).toBe("管理者");

    await h.composed.grants.removeGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MOD });
  });

  test("row menu links grant and audit pages of the Discord account", async () => {
    const member = await signIn(h, MEMBER);
    const row = await userRow(member.userId);
    expect(row.grantHref).toBe(`/dashboard/grants?subjectType=user&userId=${MEMBER}`);
    expect(row.auditHref).toBe(`/dashboard/audit?user=${MEMBER}`);
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
      createdAt: new Date(0),
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
    } as unknown as Pick<DashboardDeps, "directory" | "grants" | "users" | "resolver">;

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
    await h.composed.grants.createGrant({ permission: "discord:read", subjectType: "user", subjectId: MEMBER });
    const login = await signIn(h, MEMBER);
    const clientId = await registerClient(h);
    const before = await issueTokens(h, clientId, login.cookie);
    const listTools = (token: string) => mcpCall(h, token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect((await listTools(before.access_token)).status).toBe(200);

    expect(await revokeTokens(deps, login.userId, owner)).toEqual({ kind: "ok", message: `user-${MEMBER} のトークンを失効しました。` });
    expect((await userRow(login.userId)).revoked).toMatchObject({ label: "失効済み", tone: "secondary" });
    expect(h.events.at(-1)).toMatchObject({ event: "tokens_revoked", userId: login.userId, by: OWNER_ID });

    const rejected = await listTools(before.access_token);
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(rejected.headers.get("www-authenticate")).toContain(`resource_metadata="${h.base}/.well-known/oauth-protected-resource/mcp"`);
    expect(rejected.json).toEqual({ error: "invalid_token", error_description: "The access token has been revoked. Sign in again." });
    expect((await refreshTokens(h, clientId, before.refresh_token!)).status).not.toBe(200);
    expect(await h.composed.auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) })).toBeNull();

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

    const list = await auditList(deps, params());
    const row = list.rows.find((candidate) => candidate.id === created.auditId);
    expect(row).toMatchObject({ href: `/dashboard/audit/${created.auditId}`, operation: "ページを作成", user: { name: "Mina" }, title: "Listed" });
    expect(row?.targetUrl).toBeString();
    expect(row?.badge).toBeNull();
    expect(row?.meta).toMatch(/^ページを作成 · Mina · \d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(list.userOptions).toContainEqual({ value: MEMBER, label: "Mina" });
    expect(list.range).toMatch(/^\d+ 件中 1–\d+ 件$/);

    expect((await auditList(deps, params("operation=append_content"))).rows.some((candidate) => candidate.id === created.auditId)).toBe(false);
    const failed = await auditList(deps, params("status=failed"));
    expect(failed.rows.some((candidate) => candidate.id === created.auditId)).toBe(false);
    expect(failed.rows[0]?.badge).toEqual({ label: "失敗", tone: "destructive" });
    expect(failed.filters.status).toBe("failed");
    expect((await auditList(deps, params("user=abc"))).error).toBe("ユーザー ID は Discord の数値 ID で指定してください。");
    expect((await auditList(deps, params(`user=${STRANGER}`))).userOptions).toContainEqual({ value: STRANGER, label: STRANGER });
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
    const edited = await writes.editContent(MEMBER_ACTOR, { pageId: page.id, edits: [{ old_str: "Old line", new_str: "New line" }], request: {} });
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
      writes.editContent(MEMBER_ACTOR, { pageId: page.id, edits: [{ old_str: "absent", new_str: "x" }], request: { edits: [{ old_str: "absent", new_str: "x" }] } }),
    ).rejects.toThrow();
    const { rows } = await h.composed.notionAudit.listAudit({ status: "failed", limit: 1 });
    const detail = (await auditDetail(deps, String(rows[0]!.id), owner))!;
    expect(detail.badges).toEqual([{ label: "失敗", tone: "destructive" }]);
    expect(detail.details.error).toMatchObject({ label: "エラー", failed: true });
    expect(detail.details.error?.text).toContain("No matches found");
    expect(detail.summary).toEndWith("「Broken page」の本文の編集に失敗しました。");
    expect(detail.change).toMatchObject({ kind: "diff", lines: [{ kind: "del", text: "− absent" }, { kind: "add", text: "+ x" }] });
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
    expect((await h.composed.notionAudit.getAudit(created.auditId))!.revertedAt).toBeNull();

    expect(await revertAudit(deps, id, form({ confirm: "yes" }), owner)).toEqual({
      result: { kind: "ok", message: `取り消しました。Reverted audit #${created.auditId}.` },
      conflict: false,
    });
    const row = (await h.composed.notionAudit.getAudit(created.auditId))!;
    expect(row.revertedBy).toBe(OWNER_ID);
    expect(h.notion.pages.get(created.pageId)!.in_trash).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ event: "audit_revert", auditId: created.auditId, ok: true, force: false });

    const detail = (await auditDetail(deps, id, owner))!;
    expect(detail.revert).toEqual({ state: "reverted", revert: { id: row.revertAuditId!, href: `/dashboard/audit/${row.revertAuditId}` }, note: row.revertNote });
    expect(detail.badges.map((badge) => badge.label)).toEqual(["成功", "取り消し済み"]);

    const revertRow = (await auditDetail(deps, String(row.revertAuditId), owner))!;
    expect(revertRow.change).toEqual({ kind: "revert", of: { id: created.auditId, href: `/dashboard/audit/${created.auditId}` } });
    expect(revertRow.revert).toBeNull();
    const reverted = (await auditList(deps, params("status=reverted"))).rows.find((candidate) => candidate.id === created.auditId);
    expect(reverted?.badge).toEqual({ label: "取り消し済み", tone: "secondary" });
    const revertListRow = (await auditList(deps, params())).rows.find((candidate) => candidate.id === row.revertAuditId);
    expect(revertListRow?.meta).toStartWith(`#${created.auditId} を取り消し · `);
    expect(await revertAudit(deps, "99999", form({ confirm: "yes" }), owner)).toBeNull();
  });

  test("a conflicting revert offers a forced revert", async () => {
    const parent = h.notion.addPage({ title: "Conflict root", markdown: "Intro" });
    const appended = await writes.appendContent(MEMBER_ACTOR, { pageId: parent.id, content: "mine", request: {} });
    h.notion.setMarkdown(parent.id, "Intro\nmine\nlater edit");
    const id = String(appended.auditId);

    expect(await revertAudit(deps, id, form({ confirm: "yes" }), owner)).toEqual({ result: { kind: "warn", message: null }, conflict: true });
    expect(await revertAudit(deps, id, form({ force: "true" }), owner)).toMatchObject({ result: { kind: "error" }, conflict: true });
    expect((await auditDetail(deps, id, owner))!.details.targetUrl).toBeString();

    const forced = await revertAudit(deps, id, form({ confirm: "yes", force: "true" }), owner);
    expect(forced?.result.kind).toBe("ok");
    expect(forced?.result.message).toContain("forced despite later edits");
    expect((await h.composed.notionAudit.getAudit(appended.auditId))!.revertedAt).not.toBeNull();
  });

  test("without Notion a revert is not offered", async () => {
    const parent = h.notion.addPage({ title: "Disabled root" });
    const created = await writes.createPage(MEMBER_ACTOR, { parentId: parent.id, title: "Kept", request: {} });
    const detail = await auditDetail({ ...deps, notionEnabled: false }, String(created.auditId), owner);
    expect(detail?.revert).toEqual({ state: "disabled" });
  });
});
