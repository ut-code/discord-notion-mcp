/** Browser-facing routes, shared by the pages, Better Auth's redirects and the MCP tools. */
export const SIGN_IN_PATH = "/sign-in";
export const SIGN_IN_ERROR_PATH = "/sign-in/error";
export const SIGN_OUT_PATH = "/sign-out";
export const CONSENT_PATH = "/consent";
export const NOT_MEMBER_PATH = "/not-member";
export const ADMIN_PATH = "/admin";

export function adminAuditPath(auditId: number): string {
  return `${ADMIN_PATH}/audit/${auditId}`;
}
