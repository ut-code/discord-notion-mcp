import { m } from "../../paraglide/messages.js";
import { DASHBOARD_PATH, SIGN_IN_ERROR_PATH, SIGN_IN_PATH } from "../../paths";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { AUTH_BASE_PATH } from "../auth/auth";
import { clientNameBeforeSignIn, clientNameForSession } from "../auth/clients";
import { displayName } from "../lib/display-name";
import { errorMessage } from "../lib/errors";
import { PERMISSIONS, type Permission } from "../permissions/permissions";
import type { EffectiveAccess } from "../permissions/resolver";
import type { DashboardDeps } from "./deps";
import { safeNextPath } from "./next-path";
import { extractSignedOAuthQuery, signedOAuthParam } from "./oauth-query";

const PRODUCT_NAME = "Discord × Notion MCP";

async function orNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/** The client's registered name, else its id. */
async function clientLabel(clientId: string, lookup: () => Promise<string | null>): Promise<string> {
  return (await orNull(lookup)) ?? clientId;
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

export async function signInPage(deps: DashboardDeps, url: URL): Promise<SignInPageData> {
  const oauthQuery = extractSignedOAuthQuery(url.search) ?? null;
  const clientId = oauthQuery ? signedOAuthParam(oauthQuery, "client_id") : null;
  const [guildName, clientName] = await Promise.all([
    orNull(async () => (await deps.directory.fetchGuild()).name),
    oauthQuery && clientId ? clientLabel(clientId, () => clientNameBeforeSignIn(deps.auth, clientId, oauthQuery)) : Promise.resolve(null),
  ]);
  return {
    heading: guildName ? m.sign_in_heading_guild({ guild: guildName }) : PRODUCT_NAME,
    guildName,
    endpoint: `${AUTH_BASE_PATH}/sign-in/social`,
    errorCallbackURL: SIGN_IN_ERROR_PATH,
    oauthQuery,
    callbackURL: oauthQuery ? "/" : safeNextPath(url.searchParams.get("next")),
    clientName: oauthQuery ? clientName : null,
  };
}

export function signInErrorMessage(code: string | null): string {
  switch (code) {
    case "access_denied":
      return m.sign_in_error_cancelled();
    case "state_mismatch":
    case "please_restart_the_process":
      return m.sign_in_error_expired();
    default:
      return m.sign_in_error_unknown({ code: code ?? "unknown_error" });
  }
}

export const NOT_MEMBER = { title: m.access_denied_title(), message: m.access_not_member() };

export interface ConsentFeature {
  permission: Permission;
  title: string;
  description: string;
}

const FEATURES: Record<Permission, Omit<ConsentFeature, "permission">> = {
  "discord:read": { title: m.permission_discord_read(), description: m.consent_feature_discord_read() },
  "notion:read": { title: m.permission_notion_read(), description: m.consent_feature_notion_read() },
  "notion:write": { title: m.permission_notion_write(), description: m.consent_feature_notion_write() },
  admin: { title: m.consent_feature_admin_title(), description: m.consent_feature_admin() },
};

/** Permissions shown on the consent page; admins get everything including the dashboard's admin actions. */
function consentPermissions(access: EffectiveAccess): Permission[] {
  if (access.isAdmin) return [...PERMISSIONS];
  return PERMISSIONS.filter((permission) => permission !== "admin" && access.permissions.has(permission));
}

export interface ConsentPageData {
  endpoint: string;
  oauthQuery: string;
  clientName: string;
  /** Where the client receives the authorization code; null when the request names none. */
  redirectOrigin: string | null;
  account: { name: string; username: string; avatarUrl: string | null };
  guildName: string;
  /** Effective permissions in display order; empty when nothing is granted. */
  features: ConsentFeature[];
  /** Same-origin path to return to after switching accounts. */
  switchNext: string;
}

export type ConsentResult =
  { kind: "ok"; data: ConsentPageData } | { kind: "error"; status: 400 | 401 | 403; title: string; message: string };

/**
 * Origin of a redirect URI, so the consent page can tell a CLI's loopback callback from a
 * website; custom schemes (opaque origins) show their scheme and host.
 */
function redirectOrigin(redirectUri: string | null): string | null {
  const url = redirectUri ? URL.parse(redirectUri) : null;
  if (!url) return null;
  if (url.origin !== "null") return url.origin;
  return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}

export async function consentPage(deps: DashboardDeps, url: URL, headers: Headers): Promise<ConsentResult> {
  const oauthQuery = extractSignedOAuthQuery(url.search);
  const clientId = oauthQuery ? signedOAuthParam(oauthQuery, "client_id") : null;
  if (!oauthQuery || !clientId) {
    return { kind: "error", status: 400, title: m.error_title_400(), message: m.consent_invalid_request() };
  }
  const session = await deps.auth.api.getSession({ headers });
  if (!session) {
    return { kind: "error", status: 401, title: m.consent_session_expired_title(), message: m.sign_in_error_expired() };
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
      clientName: await clientLabel(clientId, () => clientNameForSession(deps.auth, clientId, headers)),
      redirectOrigin: redirectOrigin(signedOAuthParam(oauthQuery, "redirect_uri")),
      account: { name: displayName(access.member), username: access.member.username, avatarUrl: access.member.avatarUrl },
      guildName: access.guild.name,
      features: consentPermissions(access).map((permission) => ({ permission, ...FEATURES[permission] })),
      switchNext: `${SIGN_IN_PATH}${url.search}`,
    },
  };
}

/**
 * Ends the browser session. `next` may only return to the sign-in page (the consent
 * page uses it to resume the OAuth flow); anything else goes to the dashboard sign-in.
 */
export async function signOut(
  deps: DashboardDeps,
  headers: Headers,
  next: string,
): Promise<{ cookies: ResponseCookie[]; location: string }> {
  let cookies: ResponseCookie[] = [];
  try {
    const response = await deps.auth.api.signOut({ headers, asResponse: true });
    cookies = response.headers.getSetCookie().flatMap(responseCookies);
  } catch (error) {
    deps.logError({ event: "sign_out_failed", error: errorMessage(error) });
  }
  const location = next.startsWith(`${SIGN_IN_PATH}?`) ? safeNextPath(next) : `${SIGN_IN_PATH}?next=${encodeURIComponent(DASHBOARD_PATH)}`;
  return { cookies, location };
}

/** A Set-Cookie of Better Auth in the shape of SvelteKit's `cookies.set` (which encodes the decoded value again). */
export interface ResponseCookie {
  name: string;
  value: string;
  options: ReturnType<typeof toCookieOptions> & { path: string; httpOnly: boolean; secure: boolean };
}

function responseCookies(header: string): ResponseCookie[] {
  return [...parseSetCookieHeader(header)].map(([name, attributes]) => {
    const options = toCookieOptions(attributes);
    // Explicit values, or SvelteKit's defaults would add attributes Better Auth did not send.
    return {
      name,
      value: attributes.value,
      options: { ...options, path: options.path ?? "/", httpOnly: options.httpOnly ?? false, secure: options.secure ?? false },
    };
  });
}
