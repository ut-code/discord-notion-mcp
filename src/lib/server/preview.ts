// Local UI preview backed by fake Discord/Notion APIs and an in-memory database.
// Loaded only by the dev server with PREVIEW=1 (`bun run preview`); production builds never load it.
import { makeSignature } from "better-auth/crypto";
import { FakeDiscordApi, GUILD_ID, makeGuild, OWNER_ID, textChannel } from "./fakes/discord";
import { FakeNotionApi } from "./fakes/notion";
import { composeServer } from "./compose";
import { loadConfig } from "./config";
import { openDatabase } from "./db/client";
import { userAvatarUrl } from "./discord/avatar";
import { ADMINISTRATOR, READ_MESSAGE_HISTORY, VIEW_CHANNEL } from "./discord/permissions";
import type { MemberInfo } from "./discord/types";
import { displayName } from "./lib/display-name";
import type { Principal } from "./mcp/registry";
import type { Runtime } from "./runtime";
import type { ToolCallStore } from "./usage/tool-calls";

interface PreviewUser {
  id: string;
  name: string;
  username: string;
}

export interface Preview {
  users: PreviewUser[];
  /** A Set-Cookie value for a new browser session of the sample user; null when unknown. */
  sessionCookie(discordUserId: string): Promise<string | null>;
}

const SECRET = "preview-secret-preview-secret-preview-secret";

const ROLE_ADMIN = "200000000000000001";
const ROLE_STAFF = "200000000000000002";
const ROLE_MEMBER = "200000000000000003";
const ROLE_BOT = "200000000000000004";

/** Enough roles and members that the grant form's lists scroll, as on a real server. */
const EXTRA_ROLES = [
  "企画",
  "広報",
  "デザイン",
  "開発",
  "運営",
  "イベント",
  "翻訳",
  "サポート",
  "記録",
  "新人",
  "OB・OG",
  "ゲスト講師",
  "プロジェクト・アルファ推進ワーキンググループ",
];
const extraRoleId = (index: number) => String(210000000000000000n + BigInt(index));
/** Holds every role, with long names: how crowded rows look. */
const CROWDED_ID = "300000000000000005";

/** Discord's built-in default avatars (public images, no account behind them), so rows show real CDN avatars. */
const defaultAvatar = (index: number) => `https://cdn.discordapp.com/embed/avatars/${index}.png`;
/** As the Discord client gives them: members without an avatar get the default one for their id. */
const asListed = (member: MemberInfo): MemberInfo => ({
  ...member,
  avatarUrl: member.avatarUrl ?? userAvatarUrl({ id: member.userId, avatar: null }),
});

const people: [owner: MemberInfo, tanaka: MemberInfo, suzuki: MemberInfo, ...rest: MemberInfo[]] = [
  { userId: OWNER_ID, roles: [ROLE_ADMIN], nick: null, username: "kinako", globalName: "きなこもち", avatarUrl: defaultAvatar(0) },
  {
    userId: "300000000000000001",
    roles: [ROLE_STAFF, ROLE_MEMBER],
    nick: "田中",
    username: "tanaka",
    globalName: "Tanaka",
    avatarUrl: defaultAvatar(1),
  },
  { userId: "300000000000000002", roles: [ROLE_MEMBER], nick: null, username: "suzuki", globalName: "鈴木", avatarUrl: null },
  { userId: "300000000000000003", roles: [ROLE_MEMBER], nick: null, username: "sato", globalName: null, avatarUrl: defaultAvatar(3) },
  { userId: "300000000000000004", roles: [], nick: null, username: "guest_yamada", globalName: "山田 (guest)", avatarUrl: null },
  {
    userId: CROWDED_ID,
    roles: [ROLE_STAFF, ROLE_MEMBER, ...EXTRA_ROLES.map((_, index) => extraRoleId(index))],
    nick: "とても長い表示名を設定しているメンバーさん",
    username: "a_member_with_a_really_long_username",
    globalName: null,
    avatarUrl: null,
  },
  { userId: "300000000000000006", roles: [], nick: null, username: "no_grants", globalName: "権限なし", avatarUrl: null },
];

/** Signed in once but no longer on the server: the dashboard and consent page turn them away. */
const formerMember: MemberInfo = {
  userId: "300000000000000007",
  roles: [],
  nick: null,
  username: "left_the_server",
  globalName: "退会済み",
  avatarUrl: null,
};

const EXTRA_MEMBERS = [
  "青木",
  "石井",
  "上田",
  "遠藤",
  "大野",
  "加藤",
  "木村",
  "小林",
  "斎藤",
  "清水",
  "高橋",
  "中村",
  "西田",
  "林",
  "藤井",
  "松本",
  "森",
  "山口",
  "吉田",
  "渡辺",
];
const PALETTE = [0x1abc9c, 0x9b59b6, 0xe67e22, 0xf1c40f, 0x34495e, 0xe91e63];

type PreviewTool = [tool: string, weight: number, durationMs: number];
const PREVIEW_TOOLS: [PreviewTool, ...PreviewTool[]] = [
  ["discord_read_messages", 30, 420],
  ["discord_search_messages", 18, 900],
  ["notion_search", 16, 650],
  ["notion_get_page", 14, 380],
  ["discord_list_channels", 8, 120],
  ["notion_query_database", 6, 1200],
  ["notion_edit_content", 4, 1600],
  ["notion_create_page", 3, 1400],
  ["discord_get_message", 3, 200],
];

/** Sample usage over the last 30 days: [discordUserId, calls per active day, active-day probability]. */
const PREVIEW_USAGE: Array<[string, number, number]> = [
  [OWNER_ID, 6, 0.6],
  ["300000000000000001", 14, 0.85],
  ["300000000000000002", 8, 0.7],
  ["300000000000000003", 3, 0.4],
  ["300000000000000004", 2, 0.3],
  [CROWDED_ID, 1, 0.2],
];

function seedToolCalls(store: ToolCallStore, now = Date.now()): void {
  // Deterministic pseudo-random numbers so every preview looks the same.
  let seed = 42;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const totalWeight = PREVIEW_TOOLS.reduce((sum, [, weight]) => sum + weight, 0);
  const pickTool = () => {
    let roll = random() * totalWeight;
    for (const entry of PREVIEW_TOOLS) {
      roll -= entry[1];
      if (roll <= 0) return entry;
    }
    return PREVIEW_TOOLS[0];
  };
  for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
    const weekend = new Date(now - daysAgo * 86_400_000).getDay() % 6 === 0;
    for (const [discordUserId, perDay, activeChance] of PREVIEW_USAGE) {
      if (random() > (weekend ? activeChance / 3 : activeChance)) continue;
      const calls = Math.max(1, Math.round(perDay * (0.5 + random())));
      for (let i = 0; i < calls; i++) {
        const [tool, , durationMs] = pickTool();
        const createdAt = new Date(now - daysAgo * 86_400_000 - Math.floor(random() * 10 * 3_600_000));
        const failed = random() < 0.05;
        store.record({
          discordUserId,
          tool,
          createdAt,
          ok: !failed,
          durationMs: Math.round(durationMs * (0.6 + random() * 0.8)),
          ...(failed ? { errorKind: "error" as const, error: "Channel not found or not accessible." } : {}),
        });
      }
    }
  }
  // A burst that hit the per-user rate limit.
  for (let i = 0; i < 6; i++) {
    store.record({
      discordUserId: "300000000000000001",
      tool: "discord_read_messages",
      createdAt: new Date(now - 4 * 86_400_000 + i * 1000),
      ok: false,
      durationMs: 0,
      errorKind: "rate_limited",
      error: "Rate limit exceeded; retry in 1 s.",
    });
  }
}

export async function startPreview(): Promise<Runtime> {
  const port = Number(process.env.PORT ?? 3920);
  const discord = new FakeDiscordApi();
  discord.guild = {
    ...makeGuild([
      { id: GUILD_ID, permissions: 0n },
      { id: ROLE_ADMIN, name: "管理者", permissions: ADMINISTRATOR, color: 0xe74c3c, position: 4 },
      { id: ROLE_STAFF, name: "staff", permissions: VIEW_CHANNEL | READ_MESSAGE_HISTORY, color: 0x3498db, position: 3 },
      { id: ROLE_MEMBER, name: "member", permissions: VIEW_CHANNEL | READ_MESSAGE_HISTORY, color: 0x2ecc71, position: 2 },
      { id: ROLE_BOT, name: "MCP Bot", permissions: VIEW_CHANNEL, managed: true, position: 1 },
      ...EXTRA_ROLES.map((name, index) => ({
        id: extraRoleId(index),
        name,
        permissions: 0n,
        color: PALETTE[index % PALETTE.length],
        position: 1,
      })),
    ]),
    name: "サンプルサーバー",
    // A server icon (Discord's CDN is out of reach here; the page CSP allows data: images).
    iconUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5865f2"/><circle cx="32" cy="32" r="16" fill="#fff"/></svg>')}`,
  };
  for (const person of people) discord.members.set(person.userId, asListed(person));
  EXTRA_MEMBERS.forEach((name, index) => {
    const userId = String(310000000000000000n + BigInt(index));
    discord.members.set(
      userId,
      asListed({ userId, roles: [ROLE_MEMBER], nick: null, username: `user${index + 1}`, globalName: name, avatarUrl: null }),
    );
  });
  discord.channels = [textChannel("400000000000000001", "general"), textChannel("400000000000000002", "staff-only")];

  const notion = new FakeNotionApi();
  const wiki = notion.addPage({ title: "チーム Wiki", markdown: "# 概要\nこのページはチームの Wiki です。\n- ルール\n- 手順" });

  const database = openDatabase(":memory:");
  const config = loadConfig({
    // Set when the preview is reached through a proxy (e.g. `tailscale serve`), so the Origin check matches.
    PUBLIC_URL: process.env.PREVIEW_PUBLIC_URL ?? `http://localhost:${port}`,
    PORT: String(port),
    BETTER_AUTH_SECRET: SECRET,
    DISCORD_CLIENT_ID: "123456789012345678",
    DISCORD_CLIENT_SECRET: "x",
    DISCORD_BOT_TOKEN: "x",
    DISCORD_GUILD_ID: GUILD_ID,
    NOTION_TOKEN: "preview",
    TRUSTED_PROXY_COUNT: "0",
  });
  const server = await composeServer(config, {
    discordApi: discord,
    notionApi: notion,
    database,
    logToolCall: () => {},
    logEvent: () => {},
    otherOrigins: [`http://localhost:${port}`],
    // Templates are filled in by the fake a couple of reads after creation, so no real waiting.
    notionWriteSleep: () => Promise.resolve(),
  });
  const authContext = await server.auth.$context;

  const authUserIds = new Map<string, string>();
  for (const person of [...people, formerMember]) {
    const user = await authContext.internalAdapter.createUser(
      { name: displayName(person), email: `${person.userId}@users.discord.invalid`, emailVerified: false },
      { method: "oauth", oauth: { providerId: "discord" } },
    );
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: "discord", accountId: person.userId });
    authUserIds.set(person.userId, user.id);
  }

  await server.grants.createGrant({ permission: "discord:read", subjectType: "role", subjectId: ROLE_MEMBER, createdBy: OWNER_ID });
  await server.grants.createGrant({ permission: "notion:read", subjectType: "role", subjectId: ROLE_MEMBER, createdBy: OWNER_ID });
  await server.grants.createGrant({ permission: "notion:write", subjectType: "role", subjectId: ROLE_STAFF, createdBy: OWNER_ID });
  await server.grants.createGrant({ permission: "notion:read", subjectType: "user", subjectId: CROWDED_ID, createdBy: OWNER_ID });
  await server.grants.createGrant({
    permission: "notion:read",
    subjectType: "user",
    subjectId: "300000000000000004",
    createdBy: OWNER_ID,
  });
  await server.grants.createGrant({
    permission: "notion:write",
    subjectType: "user",
    subjectId: "300000000000000001",
    createdBy: OWNER_ID,
  });

  const tools = new Map(server.tools.map((tool) => [tool.name, tool]));
  const run = async (name: string, args: Record<string, unknown>, who: MemberInfo): Promise<string> => {
    const tool = tools.get(name);
    const userId = authUserIds.get(who.userId);
    if (!tool || !userId) throw new Error(`Preview seed refers to an unknown tool (${name}) or user (${who.userId})`);
    const principal: Principal = {
      userId,
      discordUserId: who.userId,
      access: {
        isMember: true,
        discordUserId: who.userId,
        guild: discord.guild,
        member: who,
        permissions: new Set(["notion:read", "notion:write"]),
        isAdmin: false,
      },
    };
    try {
      const result = await tool.handler(tool.inputSchema.parse(args), { principal });
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (error) {
      return String(error);
    }
  };
  const [, tanaka, suzuki] = people;
  await run(
    "notion_create_page",
    { parent: wiki.id, title: "10/12 定例議事録", content: "## 決定事項\n- リリースは 10/20\n- 担当: 田中" },
    tanaka,
  );
  await run("notion_append_content", { page: wiki.id, content: "- 新メンバー向けの手順を追加予定" }, suzuki);
  const edit = await run(
    "notion_edit_content",
    { page: wiki.id, edits: [{ old_str: "- 手順", new_str: "- 手順（2026/10 更新）" }] },
    tanaka,
  );
  await run("notion_edit_content", { page: wiki.id, edits: [{ old_str: "存在しない文章", new_str: "x" }] }, suzuki);
  const editId = Number(/audit #(\d+)/.exec(edit)?.[1]);
  if (editId) {
    await server.notionAudit.revert(editId, { actorDiscordUserId: OWNER_ID, actorDisplayName: "きなこもち", actorUsername: "kinako" });
  }
  await run("notion_archive_page", { page: notion.addPage({ title: "古いメモ" }).id }, tanaka);
  // Edited afterwards in Notion, so a revert is refused and the page has to be fixed by hand.
  const draft = notion.addPage({ title: "下書き", markdown: "下書き" });
  await run("notion_append_content", { page: draft.id, content: "- 追記した行" }, suzuki);
  notion.setMarkdown(draft.id, `${notion.markdown.get(draft.id) ?? ""}\n- 後からの編集`);
  // A database row made from a template, which Notion fills in.
  const minutes = notion.addDataSource({
    title: "議事録",
    databaseId: "00000000-0000-4000-8000-0000000000d1",
    properties: { 名前: { id: "title", name: "名前", type: "title", title: {} } },
  });
  const template = notion.addPage({ title: "定例テンプレート", markdown: "## 議題\n- \n## 決定事項\n- " });
  notion.templates.set(minutes.id, [{ id: template.id, name: "定例テンプレート", isDefault: true }]);
  await run("notion_create_page", { parent: minutes.id, title: "10/26 定例", template_id: template.id }, tanaka);
  seedToolCalls(server.toolCalls);

  const sessionCookie = async (discordUserId: string): Promise<string | null> => {
    const userId = authUserIds.get(discordUserId);
    if (!userId) return null;
    const session = await authContext.internalAdapter.createSession(userId);
    const value = encodeURIComponent(`${session.token}.${await makeSignature(session.token, SECRET)}`);
    const { name, attributes } = authContext.authCookies.sessionToken;
    // Over https (e.g. tailscale serve) the name carries the __Secure- prefix, which browsers only accept with Secure.
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${attributes.secure ? "; Secure" : ""}`;
  };

  console.log(`preview ready: ${config.publicUrl}/dev`);
  return {
    server,
    preview: {
      users: [...people, formerMember].map((person) => ({ id: person.userId, name: displayName(person), username: person.username })),
      sessionCookie,
    },
  };
}
