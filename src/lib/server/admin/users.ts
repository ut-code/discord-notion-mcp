import { DASHBOARD_PATH } from "../../paths";
import type { LoginUser } from "../auth/users";
import { errorMessage } from "../lib/errors";
import { createLimiter } from "../lib/limiter";
import { ADMIN_ONLY, type Viewer } from "./access";
import { auditListHref } from "./audit";
import type { BadgeView } from "./badges";
import type { AdminDeps } from "./deps";
import { formatJst, formatShortJst, PERMISSION_LABELS } from "./format";
import { GRANTS_PATH } from "./grants";
import { pageParam, type ActionResult } from "./shared";
import { buildUserRow, matchesUserQuery, type UserRowView } from "./views";

export const USERS_PAGE_SIZE = 50;
const USERS_PATH = `${DASHBOARD_PATH}/users`;
/** Searching users filters resolved rows in memory; logins beyond this are not searched. */
const USER_SEARCH_SCAN_LIMIT = 1000;
const VISIBLE_ROLES = 2;

export interface UserTableRow {
  /** Better Auth user id (revocation target). */
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  /** Tooltip of the user cell. */
  title: string;
  roles: { text: string; title: string | null };
  /** Empty when nothing is held (shown as —). */
  permissions: Array<BadgeView & { individual: boolean }>;
  lastLogin: string;
  revoked: BadgeView | null;
  /** Row menu links; null without a linked Discord account or when the viewer cannot open the page. */
  grantHref: string | null;
  auditHref: string | null;
}

export interface UsersPageData {
  rows: UserTableRow[];
  /** Admins only. */
  canRevoke: boolean;
  query: string;
  total: number;
  prevHref: string | null;
  nextHref: string | null;
  empty: string;
}

function usersHref(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search ? `${USERS_PATH}?${search}` : USERS_PATH;
}

function rolesLine(row: UserRowView): UserTableRow["roles"] {
  const plain = (text: string) => ({ text, title: null });
  if (row.membership === "not_member") return plain("サーバー未参加");
  if (row.membership === "unlinked") return plain("Discord 未連携");
  if (row.membership === "unknown") return plain("確認できません");
  if (row.implicitAdmin) return plain("管理者");
  const names = row.roles.map((role) => role.name);
  if (names.length === 0) return plain("ロールなし");
  if (names.length <= VISIBLE_ROLES) return plain(names.join(", "));
  return { text: `${names.slice(0, VISIBLE_ROLES).join(", ")} 他 ${names.length - VISIBLE_ROLES}`, title: names.join(", ") };
}

function permissionBadges(row: UserRowView): UserTableRow["permissions"] {
  const individual = new Set(row.individual);
  const badge = (permission: keyof typeof PERMISSION_LABELS, dark: boolean) => ({
    label: PERMISSION_LABELS[permission],
    tone: dark ? ("dark" as const) : ("secondary" as const),
    title: individual.has(permission) ? "個人に付与" : undefined,
    individual: individual.has(permission),
  });
  if (row.isAdmin) return [badge("admin", true)];
  return row.permissions.map((permission) => badge(permission, false));
}

function wasRevokedSinceLogin(user: LoginUser): boolean {
  return user.revokedAt !== null && (user.lastLoginAt === null || user.revokedAt >= user.lastLoginAt);
}

export function userTableRow(row: UserRowView, viewer: Pick<Viewer, "isAdmin" | "canViewAudit">): UserTableRow {
  const discordUserId = row.user.discordUserId;
  return {
    userId: row.user.userId,
    displayName: row.displayName,
    username: row.username,
    avatarUrl: row.avatarUrl,
    title: `Discord ID ${discordUserId ?? "—"}`,
    roles: rolesLine(row),
    permissions: permissionBadges(row),
    lastLogin: formatShortJst(row.user.lastLoginAt),
    revoked: wasRevokedSinceLogin(row.user) ? { label: "失効済み", tone: "secondary", title: `${formatJst(row.user.revokedAt)} に失効` } : null,
    grantHref: discordUserId && viewer.isAdmin ? `${GRANTS_PATH}?subjectType=user&userId=${encodeURIComponent(discordUserId)}` : null,
    auditHref: discordUserId && viewer.canViewAudit ? auditListHref({ user: discordUserId }) : null,
  };
}

export async function usersPage(deps: AdminDeps, params: URLSearchParams, viewer: Viewer): Promise<UsersPageData> {
  const query = params.get("q")?.trim() ?? "";
  const page = pageParam(params.get("page"));
  const offset = (page - 1) * USERS_PAGE_SIZE;
  const [guild, grants] = await Promise.all([deps.directory.fetchGuild(), deps.grants.listGrants()]);
  const limit = createLimiter(4);
  const toRow = (user: LoginUser) =>
    limit(async (): Promise<UserRowView> => {
      if (!user.discordUserId) return buildUserRow(user, null, guild, grants);
      try {
        return buildUserRow(user, await deps.resolver.resolve(user.discordUserId), guild, grants);
      } catch (error) {
        return buildUserRow(user, error instanceof Error ? error : new Error(errorMessage(error)), guild, grants);
      }
    });

  let rows: UserRowView[];
  let total: number;
  if (query) {
    const all = await Promise.all((await deps.users.list({ limit: USER_SEARCH_SCAN_LIMIT, offset: 0 })).map(toRow));
    const matched = all.filter((row) => matchesUserQuery(row, query));
    total = matched.length;
    rows = matched.slice(offset, offset + USERS_PAGE_SIZE);
  } else {
    const [count, users] = await Promise.all([deps.users.count(), deps.users.list({ limit: USERS_PAGE_SIZE, offset })]);
    total = count;
    rows = await Promise.all(users.map(toRow));
  }
  const hasNext = offset + rows.length < total;
  return {
    rows: rows.map((row) => userTableRow(row, viewer)),
    canRevoke: viewer.isAdmin,
    query,
    total,
    prevHref: page > 1 ? usersHref(query, page - 1) : null,
    nextHref: hasNext ? usersHref(query, page + 1) : null,
    empty: query ? `「${query}」に一致するユーザーはいません。` : "まだログインしたユーザーはいません。",
  };
}

export async function revokeTokens(deps: AdminDeps, userId: string, actor: Viewer): Promise<ActionResult> {
  if (!actor.isAdmin) return ADMIN_ONLY;
  const user = userId ? await deps.users.find(userId) : null;
  if (!user) return { kind: "error", message: "ユーザーが見つかりません。" };
  const result = deps.revocation.revoke(user.userId);
  deps.log({
    event: "tokens_revoked",
    userId: user.userId,
    by: actor.discordUserId,
    sessions: result.sessions,
    refreshTokens: result.refreshTokens,
    accessTokens: result.accessTokens,
  });
  return { kind: "ok", message: `${user.name} のトークンを失効しました。` };
}
