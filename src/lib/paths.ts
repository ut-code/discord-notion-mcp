/** Browser-facing routes, shared by the pages, Better Auth's redirects and the MCP tools. */
export const SIGN_IN_PATH = "/sign-in";
export const SIGN_IN_ERROR_PATH = "/sign-in/error";
export const SIGN_OUT_PATH = "/sign-out";
export const CONSENT_PATH = "/consent";
export const NOT_MEMBER_PATH = "/not-member";
/** Public page explaining how to register the MCP server in a client. */
export const CONNECT_PATH = "/";
export const DASHBOARD_PATH = "/dashboard";
/** POST endpoint that stores the color theme cookie. */
export const THEME_PATH = "/theme";

/** Every MCP tool with the description the AI reads; `#<tool name>` opens one. */
export const TOOLS_PATH = `${DASHBOARD_PATH}/tools`;

export function toolPath(name: string): string {
  return `${TOOLS_PATH}#${name}`;
}

export function dashboardAuditPath(auditId: number): string {
  return `${DASHBOARD_PATH}/audit/${auditId}`;
}
