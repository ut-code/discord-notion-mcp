import { m } from "../../paraglide/messages.js";
import { DASHBOARD_PATH, SIGN_IN_PATH } from "../../paths";
import { isGuildOwner } from "../discord/permissions";
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
  roleLabel: string;
  guildName: string;
  /** Grants, revocations and reverts. */
  isAdmin: boolean;
  /** The write history: writers see their own writes (notion:write), admins everyone's. */
  canViewAudit: boolean;
}

export type ViewerGate =
  { kind: "signed-out" } | { kind: "denied"; status: 403 | 503; title: string; message: string } | { kind: "viewer"; viewer: Viewer };

/** Every dashboard page requires a guild member's browser session. */
export async function checkViewer(deps: DashboardDeps, headers: Headers): Promise<ViewerGate> {
  const session = await deps.auth.api.getSession({ headers });
  if (!session) return { kind: "signed-out" };
  const discordUserId = await deps.identity.discordUserIdForUser(session.user.id);
  if (!discordUserId) {
    return { kind: "denied", status: 403, title: m.access_denied_title(), message: m.access_not_linked() };
  }
  let access: EffectiveAccess;
  try {
    access = await deps.resolver.resolve(discordUserId);
  } catch (error) {
    deps.logError({ event: "access_resolution_failed", source: "dashboard", discordUserId, error: errorMessage(error) });
    return { kind: "denied", status: 503, title: m.access_unavailable_title(), message: m.access_unavailable() };
  }
  if (!access.isMember) return { kind: "denied", status: 403, ...NOT_MEMBER };
  return {
    kind: "viewer",
    viewer: {
      discordUserId,
      displayName: displayName(access.member),
      username: access.member.username,
      avatarUrl: access.member.avatarUrl,
      roleLabel: isGuildOwner(access.guild, access.member) ? m.role_owner() : access.isAdmin ? m.role_admin() : m.role_member(),
      guildName: access.guild.name,
      isAdmin: access.isAdmin,
      canViewAudit: access.permissions.has("notion:write"),
    },
  };
}

/** Result of an admin-only action attempted by a non-admin; nothing is changed. */
export const ADMIN_ONLY: ActionResult = { kind: "error", message: m.access_admin_only_action(), status: 403 };

/** Sign-in URL that returns to the requested page (form posts return to the dashboard top). */
export function signInRedirect(url: URL, method: string): string {
  const target = method === "GET" ? `${url.pathname}${url.search}` : DASHBOARD_PATH;
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(target)}`;
}
