import { ADMIN_PATH, SIGN_IN_PATH } from "../../paths";
import type { EffectiveAccess } from "../authz/resolver";
import { displayName } from "../lib/display-name";
import { errorMessage } from "../lib/errors";
import type { AdminDeps } from "./deps";

/** The signed-in admin shown in the sidebar and recorded as the actor of admin actions. */
export interface AdminView {
  discordUserId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  /** "オーナー" or "管理者". */
  roleLabel: string;
  guildName: string;
}

export type AdminGate =
  | { kind: "signed-out" }
  | { kind: "denied"; status: 403 | 503; title: string; message: string }
  | { kind: "admin"; admin: AdminView };

const NOT_ADMIN = "管理画面は Discord サーバーの管理者だけが使えます。";

/** Every admin page and action requires a guild admin's browser session. */
export async function checkAdmin(deps: AdminDeps, headers: Headers): Promise<AdminGate> {
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
    deps.log({ event: "admin_access_resolution_failed", discordUserId, error: errorMessage(error) });
    return {
      kind: "denied",
      status: 503,
      title: "一時的に確認できません",
      message: "Discord サーバーのメンバーシップを確認できませんでした。しばらくしてから再読み込みしてください。",
    };
  }
  if (!access.isMember || !access.isAdmin) return { kind: "denied", status: 403, title: "アクセスできません", message: NOT_ADMIN };
  return {
    kind: "admin",
    admin: {
      discordUserId,
      displayName: displayName(access.member),
      username: access.member.username,
      avatarUrl: access.member.avatarUrl,
      roleLabel: access.member.userId === access.guild.ownerId ? "オーナー" : "管理者",
      guildName: access.guild.name,
    },
  };
}

/** Sign-in URL that returns to the requested admin page (form posts return to the overview). */
export function signInRedirect(url: URL, method: string): string {
  const target = method === "GET" ? `${url.pathname}${url.search}` : ADMIN_PATH;
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(target)}`;
}
