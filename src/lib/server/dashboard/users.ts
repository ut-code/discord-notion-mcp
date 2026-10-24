import { m } from "../../paraglide/messages.js";
import { DASHBOARD_PATH } from "../../paths";
import type { LoginUser } from "../auth/users";
import { givesPermission, type Permission } from "../permissions/permissions";
import { errorMessage } from "../lib/errors";
import { createLimiter } from "../lib/limiter";
import { ADMIN_ONLY, type Viewer } from "./access";
import type { BadgeView } from "./badges";
import type { DashboardDeps } from "./deps";
import { formatShortJst, PERMISSION_LABELS, roleSummary } from "./format";
import { GRANTS_PATH } from "./grants";
import { historyHref } from "./history";
import { pageLinks, pageParam, type ActionResult } from "./shared";
import { buildUserRow, matchesUserQuery, type UserRowView } from "./views";

const USERS_PAGE_SIZE = 50;
const USERS_PATH = `${DASHBOARD_PATH}/users`;
/**
 * A search matches resolved names (Discord display name, @username), so it loads and
 * resolves the newest logins up to this many and filters them in memory. Older logins
 * are never matched, and the reported total counts only the scanned ones. Names and roles
 * come from the member list, so scanning costs no lookup per login.
 */
export const USER_SEARCH_SCAN_LIMIT = 1000;

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
  /** Last tool call: what tells whether someone still uses the server (browser sign-ins are rare). */
  lastUsed: string;
  /** When the tokens were revoked after the last sign-in, the line saying so. */
  revoked: string | null;
  /** Row menu links; null without a linked Discord account or when the viewer cannot open the page. */
  grantHref: string | null;
  /** The row's history (its calls and Notion writes): admins for anyone, others for themselves. */
  historyHref: string | null;
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
  if (row.membership === "not_member") return plain(m.users_roles_not_member());
  if (row.membership === "unlinked") return plain(m.users_roles_unlinked());
  if (row.membership === "unknown") return plain(m.users_roles_unknown());
  if (row.implicitAdmin) return plain(m.role_admin());
  const names = row.roles.map((role) => role.name);
  if (names.length === 0) return plain(m.common_no_roles());
  const text = roleSummary(names);
  const all = names.join(", ");
  return { text, title: text === all ? null : all };
}

/** How a permission reads when it is shown with the permissions it includes. */
const WITH_INCLUDED_LABELS: Partial<Record<Permission, () => string>> = { "notion:write": m.users_notion_read_write };

function permissionBadges(row: UserRowView): UserTableRow["permissions"] {
  const individual = new Set(row.individual);
  const badge = (label: string, permissions: Permission[], dark = false) => {
    const isIndividual = permissions.some((permission) => individual.has(permission));
    return {
      label,
      tone: dark ? ("dark" as const) : ("secondary" as const),
      title: isIndividual ? m.users_individual_grant() : undefined,
      individual: isIndividual,
    };
  };
  if (row.isAdmin) return [badge(PERMISSION_LABELS.admin, ["admin"], true)];
  // A permission that includes others shows as one badge naming them all, not a badge each.
  const shown = row.permissions.filter(
    (permission) => !row.permissions.some((other) => other !== permission && givesPermission(other, permission)),
  );
  return shown.map((permission) => {
    const covered = row.permissions.filter((other) => givesPermission(permission, other));
    const label =
      covered.length > 1 ? (WITH_INCLUDED_LABELS[permission]?.() ?? PERMISSION_LABELS[permission]) : PERMISSION_LABELS[permission];
    return badge(label, covered);
  });
}

function wasRevokedSinceLogin(user: LoginUser): boolean {
  return user.revokedAt !== null && (user.lastLoginAt === null || user.revokedAt >= user.lastLoginAt);
}

function userTableRow(
  row: UserRowView,
  lastUsed: Date | undefined,
  viewer: Pick<Viewer, "isAdmin" | "discordUserId" | "permissions">,
  deps: Pick<DashboardDeps, "tools">,
): UserTableRow {
  const discordUserId = row.user.discordUserId;
  return {
    userId: row.user.userId,
    displayName: row.displayName,
    username: row.username,
    avatarUrl: row.avatarUrl,
    title: `Discord ID ${discordUserId ?? "—"}`,
    roles: rolesLine(row),
    permissions: permissionBadges(row),
    lastUsed: formatShortJst(lastUsed),
    revoked: wasRevokedSinceLogin(row.user) ? m.users_revoked_at({ time: formatShortJst(row.user.revokedAt) }) : null,
    // Admins hold every permission already, so the form is not offered for them.
    grantHref:
      discordUserId && viewer.isAdmin && !row.isAdmin ? `${GRANTS_PATH}?subject=${encodeURIComponent(`user:${discordUserId}`)}` : null,
    historyHref: !discordUserId
      ? null
      : viewer.isAdmin
        ? historyHref(deps, viewer, discordUserId)
        : discordUserId === viewer.discordUserId
          ? historyHref(deps, viewer)
          : null,
  };
}

export async function usersPage(
  deps: Pick<DashboardDeps, "directory" | "members" | "grants" | "users" | "resolver" | "usage" | "logError" | "tools">,
  params: URLSearchParams,
  viewer: Viewer,
): Promise<UsersPageData> {
  const query = params.get("q")?.trim() ?? "";
  const page = pageParam(params.get("page"));
  const offset = (page - 1) * USERS_PAGE_SIZE;
  const [guild, grants, roster] = await Promise.all([
    deps.directory.fetchGuild(),
    deps.grants.listGrants(),
    deps.members.roster().catch((error: unknown) => {
      deps.logError({ event: "admin_lookup_failed", lookup: "member_list", error: errorMessage(error) });
      return null;
    }),
  ]);
  // Members come with their roles from the list; anyone not on it (who left, joined since, or
  // is past what a large guild lists) is looked up one by one.
  const accessOf = (discordUserId: string) => {
    const listed = roster?.byId.get(discordUserId)?.member;
    return listed ? deps.resolver.accessOf(discordUserId, guild, listed) : deps.resolver.resolve(discordUserId);
  };
  const limit = createLimiter(4);
  const toRow = (user: LoginUser) =>
    limit(async (): Promise<UserRowView> => {
      if (!user.discordUserId) return buildUserRow(user, null, guild, grants);
      try {
        return buildUserRow(user, await accessOf(user.discordUserId), guild, grants);
      } catch (error) {
        deps.logError({
          event: "access_resolution_failed",
          source: "dashboard",
          discordUserId: user.discordUserId,
          error: errorMessage(error),
        });
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
  const { prevHref, nextHref } = pageLinks(page, USERS_PAGE_SIZE, total, rows.length, (target) => usersHref(query, target));
  const lastUsed = deps.usage.lastUsed(rows.flatMap((row) => (row.user.discordUserId ? [row.user.discordUserId] : [])));
  return {
    rows: rows.map((row) => userTableRow(row, row.user.discordUserId ? lastUsed.get(row.user.discordUserId) : undefined, viewer, deps)),
    canRevoke: viewer.isAdmin,
    query,
    total,
    prevHref,
    nextHref,
    empty: query ? m.users_empty_query({ query }) : m.users_empty(),
  };
}

export async function revokeTokens(deps: DashboardDeps, userId: string, actor: Viewer): Promise<ActionResult> {
  if (!actor.isAdmin) return ADMIN_ONLY;
  const user = userId ? await deps.users.find(userId) : null;
  if (!user) return { kind: "error", message: m.users_not_found() };
  const result = deps.revocation.revoke(user.userId);
  deps.log({
    event: "tokens_revoked",
    userId: user.userId,
    by: actor.discordUserId,
    sessions: result.sessions,
    refreshTokens: result.refreshTokens,
    accessTokens: result.accessTokens,
  });
  return { kind: "ok", message: m.users_revoked_tokens({ name: user.name }) };
}
