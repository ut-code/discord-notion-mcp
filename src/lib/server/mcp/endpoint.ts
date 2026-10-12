import { requireMcpAuth } from "@better-auth/mcp";
import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import type { Auth } from "../auth/auth";
import { errorMessage } from "../lib/errors";
import { logError, type ErrorSink } from "../lib/log";
import { TokenBucketLimiter } from "../lib/rate-limit";
import type { EffectiveAccess } from "../permissions/resolver";
import type { AnyToolDefinition, Principal } from "./registry";
import { buildMcpServer, type McpServerDeps } from "./server";

/** Per Discord user: bursts of up to 30 tool calls, then one per second. */
const TOOL_CALL_BURST = 30;
const TOOL_CALLS_PER_SECOND = 1;

export interface McpEndpointDeps {
  auth: Auth;
  /** Canonical protected resource identifier (the public /mcp URL). */
  resource: string;
  /** Expected access token issuer. */
  issuer: string;
  discordUserIdFromClaims: (claims: { sub?: unknown }) => Promise<string | null>;
  resolveAccess: (discordUserId: string) => Promise<EffectiveAccess>;
  /** Whether a token of the Better Auth user with this `iat` claim was revoked. */
  isTokenRevoked: (userId: string, issuedAt: unknown) => boolean;
  tools: readonly AnyToolDefinition[];
  log?: McpServerDeps["log"];
  record?: McpServerDeps["record"];
  logError?: ErrorSink;
  /** Defaults to an in-memory token bucket per Discord user. */
  rateLimit?: McpServerDeps["rateLimit"];
}

const PRINCIPAL_KEY = "principal";

function jsonRpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });
}

/** RFC 6750 invalid_token challenge with the RFC 9728 metadata pointer, so clients re-authorize. */
function revokedTokenResponse(resource: string): Response {
  return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, "The access token has been revoked. Sign in again."), {
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resource)),
  });
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.replace(/^(Bearer|DPoP)\s+/i, "");
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createMcpEndpoint(deps: McpEndpointDeps): (request: Request) => Promise<Response> {
  const reportError = deps.logError ?? logError;
  const serverDeps: McpServerDeps = {
    tools: deps.tools,
    resolveAccess: deps.resolveAccess,
    rateLimit: deps.rateLimit ?? new TokenBucketLimiter({ capacity: TOOL_CALL_BURST, refillPerSecond: TOOL_CALLS_PER_SECOND }),
    log: deps.log,
    record: deps.record,
    logError: reportError,
  };
  const handler = createMcpHandler(
    (ctx) => {
      const principal = ctx.authInfo?.extra?.[PRINCIPAL_KEY] as Principal | undefined;
      if (!principal) throw new Error("MCP server factory invoked without an authenticated principal");
      return buildMcpServer(principal, serverDeps);
    },
    {
      // Serve 2025-era clients (initialize handshake, protocol 2025-03-26 .. 2025-11-25)
      // through the SDK's stateless fallback alongside 2026-07-28 traffic.
      legacy: "stateless",
      onerror: (error) => reportError({ event: "mcp_error", error: error.message }),
    },
  );

  return requireMcpAuth(
    deps.auth,
    async (request, claims) => {
      const userId = stringClaim(claims.sub);
      if (userId && deps.isTokenRevoked(userId, claims.iat)) return revokedTokenResponse(deps.resource);
      const discordUserId = userId ? await deps.discordUserIdFromClaims(claims) : null;
      if (!userId || !discordUserId) return jsonRpcError(403, "No Discord account is linked to this login.");

      let access: EffectiveAccess;
      try {
        access = await deps.resolveAccess(discordUserId);
      } catch (error) {
        reportError({ event: "access_resolution_failed", source: "mcp", discordUserId, error: errorMessage(error) });
        return jsonRpcError(503, "Could not verify your Discord server membership right now. Please retry shortly.");
      }
      if (!access.isMember) return jsonRpcError(403, "You are not a member of the Discord server served by this MCP server.");

      const clientId = stringClaim(claims.azp) ?? stringClaim(claims.client_id) ?? "unknown";
      const principal: Principal = { userId, discordUserId, clientId, access };
      const authInfo: AuthInfo = {
        token: bearerToken(request),
        clientId,
        scopes: (stringClaim(claims.scope) ?? "").split(" ").filter(Boolean),
        expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
        resource: new URL(deps.resource),
        extra: { [PRINCIPAL_KEY]: principal },
      };
      return handler.fetch(request, { authInfo });
    },
    { resource: deps.resource, issuer: deps.issuer },
  );
}
