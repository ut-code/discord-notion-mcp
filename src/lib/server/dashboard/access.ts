import { DASHBOARD_PATH, SIGN_IN_PATH } from "../../paths";
import type { EffectiveAccess } from "../permissions/resolver";
import { displayName } from "../lib/display-name";
import { errorMessage } from "../lib/errors";
import type { DashboardDeps } from "./deps";
import { NOT_MEMBER } from "./session";
import type { ActionResult } from "./shared";

/** The signed-in guild member shown in the sidebar; admins are also the actor of admin actions. */
export interface Viewer {
  discordUserId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  roleLabel: "オーナー" | "管理者" | "メンバー";
  guildName: string;
  /** Grants, revocations and reverts. */
  isAdmin: boolean;
  /** The write history shows Notion content: notion:read (admins hold every permission). */
  canViewAudit: boolean;
}

export type ViewerGate =
  | { kind: "signed-out" }
  | { kind: "denied"; status: 403 | 503; title: string; message: string }
  | { kind: "viewer"; viewer: Viewer };

/** Every dashboard page requires a guild member's browser session. */
export async function checkViewer(deps: DashboardDeps, headers: Headers): Promise<ViewerGate> {
  const session = await deps.auth.api.getSession({ headers });
  if (!session) return { kind: "signed-out" };
  const discordUserId = await deps.identity.discordUserIdForUser(session.user.id);
  if (!discordUserId) {
    return { kind: "denied", status: 403, title: "アクセスできません", message: "このログインには Discord アカウントが連携されていません。" };
  }
  let access: EffectiveAccess;
  try {
    access = await deps.resolver.resolve(discordUserId);
  } catch (error) {
    deps.logError({ event: "access_resolution_failed", source: "dashboard", discordUserId, error: errorMessage(error) });
    return {
      kind: "denied",
      status: 503,
      title: "一時的に確認できません",
      message: "Discord サーバーのメンバーシップを確認できませんでした。しばらくしてから再読み込みしてください。",
    };
  }
  if (!access.isMember) return { kind: "denied", status: 403, ...NOT_MEMBER };
  const isOwner = access.member.userId === access.guild.ownerId;
  return {
    kind: "viewer",
    viewer: {
      discordUserId,
      displayName: displayName(access.member),
      username: access.member.username,
      avatarUrl: access.member.avatarUrl,
      roleLabel: isOwner ? "オーナー" : access.isAdmin ? "管理者" : "メンバー",
      guildName: access.guild.name,
      isAdmin: access.isAdmin,
      canViewAudit: access.permissions.has("notion:read"),
    },
  };
}

/** Result of an admin-only action attempted by a non-admin; nothing is changed. */
export const ADMIN_ONLY: ActionResult = { kind: "error", message: "この操作は管理者だけが行えます。", status: 403 };

/** Sign-in URL that returns to the requested page (form posts return to the overview). */
export function signInRedirect(url: URL, method: string): string {
  const target = method === "GET" ? `${url.pathname}${url.search}` : DASHBOARD_PATH;
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(target)}`;
}
