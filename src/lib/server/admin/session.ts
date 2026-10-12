import { ADMIN_PATH, SIGN_IN_ERROR_PATH, SIGN_IN_PATH } from "../../paths";
import { AUTH_BASE_PATH } from "../auth/auth";
import { PERMISSIONS, type Permission } from "../authz/permissions";
import type { EffectiveAccess } from "../authz/resolver";
import { displayName } from "../lib/display-name";
import { errorMessage } from "../lib/errors";
import { safeNextPath } from "../web/next-path";
import { extractSignedOAuthQuery } from "../web/oauth-query";
import type { AdminDeps } from "./deps";

export const PRODUCT_NAME = "Discord × Notion MCP";
const RESTART = "MCP クライアントで接続し直してください。";

async function orNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

async function clientLabel(deps: AdminDeps, clientId: string): Promise<string> {
  return (await orNull(() => deps.clientNames.nameFor(clientId))) ?? clientId;
}

export interface SignInPageData {
  heading: string;
  /** Initial shown in the logo tile. */
  guildName: string | null;
  endpoint: string;
  errorCallbackURL: string;
  /** Signed authorization query when resuming an OAuth flow. */
  oauthQuery: string | null;
  /** Where a plain (non-OAuth) sign-in lands. */
  callbackURL: string;
  /** Shown while resuming an OAuth flow. */
  clientName: string | null;
}

export async function signInPage(deps: AdminDeps, url: URL): Promise<SignInPageData> {
  const oauthQuery = extractSignedOAuthQuery(url.search) ?? null;
  const clientId = oauthQuery ? new URLSearchParams(oauthQuery).get("client_id") : null;
  const [guildName, clientName] = await Promise.all([
    orNull(async () => (await deps.directory.fetchGuild()).name),
    clientId ? clientLabel(deps, clientId) : Promise.resolve(null),
  ]);
  return {
    heading: guildName ? `${guildName} の MCP` : PRODUCT_NAME,
    guildName,
    endpoint: `${AUTH_BASE_PATH}/sign-in/social`,
    errorCallbackURL: SIGN_IN_ERROR_PATH,
    oauthQuery,
    callbackURL: oauthQuery ? "/" : safeNextPath(url.searchParams.get("next")),
    clientName: oauthQuery ? clientName : null,
  };
}

const SIGN_IN_ERRORS: Record<string, string> = {
  access_denied: "Discord でのログインがキャンセルされました。",
  state_mismatch: `ログインの有効期限が切れました。${RESTART}`,
  please_restart_the_process: `ログインの有効期限が切れました。${RESTART}`,
};

export function signInErrorMessage(code: string | null): string {
  const key = code ?? "unknown_error";
  return SIGN_IN_ERRORS[key] ?? `ログインに失敗しました（${key}）。${RESTART}`;
}

export const NOT_MEMBER = {
  title: "アクセスできません",
  message: "Discord サーバーのメンバーであることを確認できませんでした。参加してから、MCP クライアントで接続し直してください。",
};

export interface ConsentFeature {
  permission: Permission;
  title: string;
  description: string;
}

const FEATURES: Record<Permission, Omit<ConsentFeature, "permission">> = {
  "discord:read": { title: "Discord 読み取り", description: "あなたが閲覧できるチャンネルのメッセージの取得・検索" },
  "notion:read": { title: "Notion 読み取り", description: "共有されたページ・データベースの検索と閲覧" },
  "notion:write": { title: "Notion 書き込み", description: "変更はあなたの名前で記録され、あなたか管理者があとから取り消せます" },
  admin: { title: "管理画面", description: "権限とユーザーの管理" },
};

/** Permissions shown on the consent page; admins get everything including the admin UI. */
export function consentPermissions(access: EffectiveAccess): Permission[] {
  if (access.isAdmin) return [...PERMISSIONS];
  return PERMISSIONS.filter((permission) => permission !== "admin" && access.permissions.has(permission));
}

export interface ConsentPageData {
  endpoint: string;
  oauthQuery: string;
  clientName: string;
  account: { name: string; username: string; avatarUrl: string | null };
  guildName: string;
  /** Effective permissions in display order; empty when nothing is granted. */
  features: ConsentFeature[];
  /** Same-origin path to return to after switching accounts. */
  switchNext: string;
}

export type ConsentResult =
  | { kind: "ok"; data: ConsentPageData }
  | { kind: "error"; status: 400 | 401 | 403; title: string; message: string };

export async function consentPage(deps: AdminDeps, url: URL, headers: Headers): Promise<ConsentResult> {
  const oauthQuery = extractSignedOAuthQuery(url.search);
  const clientId = url.searchParams.get("client_id");
  if (!oauthQuery || !clientId) {
    return { kind: "error", status: 400, title: "無効なリクエスト", message: "このページは MCP クライアントの認可フローから開いてください。" };
  }
  const session = await deps.auth.api.getSession({ headers });
  if (!session) {
    return { kind: "error", status: 401, title: "セッションの有効期限切れ", message: `ログインの有効期限が切れました。${RESTART}` };
  }
  const access = await orNull(async () => {
    const discordUserId = await deps.identity.discordUserIdForUser(session.user.id);
    return discordUserId ? deps.resolver.resolve(discordUserId) : null;
  });
  if (!access?.isMember) return { kind: "error", status: 403, ...NOT_MEMBER };
  return {
    kind: "ok",
    data: {
      endpoint: `${AUTH_BASE_PATH}/oauth2/consent`,
      oauthQuery,
      clientName: await clientLabel(deps, clientId),
      account: { name: displayName(access.member), username: access.member.username, avatarUrl: access.member.avatarUrl },
      guildName: access.guild.name,
      features: consentPermissions(access).map((permission) => ({ permission, ...FEATURES[permission] })),
      switchNext: `${SIGN_IN_PATH}${url.search}`,
    },
  };
}

/**
 * Ends the browser session. `next` may only return to the sign-in page (the consent
 * page uses it to resume the OAuth flow); anything else goes to the admin sign-in.
 */
export async function signOut(deps: AdminDeps, headers: Headers, next: string): Promise<{ cookies: string[]; location: string }> {
  let cookies: string[] = [];
  try {
    const response = await deps.auth.api.signOut({ headers, asResponse: true });
    cookies = response.headers.getSetCookie();
  } catch (error) {
    deps.log({ event: "admin_sign_out_failed", error: errorMessage(error) });
  }
  const location = next.startsWith(`${SIGN_IN_PATH}?`) ? safeNextPath(next) : `${SIGN_IN_PATH}?next=${encodeURIComponent(ADMIN_PATH)}`;
  return { cookies, location };
}
