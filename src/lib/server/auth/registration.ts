import { isLoopbackHost } from "../lib/loopback";

function isNativeRedirectUri(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return false;
  if (url.protocol === "http:") return isLoopbackHost(url.hostname);
  return true;
}

/**
 * MCP CLIs (Claude Code, Codex) register via DCR as public clients with loopback
 * redirect URIs but omit `application_type`, which RFC 7591/OIDC default to "web".
 * Better Auth then rejects the http loopback redirects. Such clients are native
 * apps per RFC 8252, so we fill in `application_type: "native"` for them only.
 */
export function withInferredApplicationType(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const metadata = body as Record<string, unknown>;
  if (metadata.application_type !== undefined) return null;
  if (metadata.token_endpoint_auth_method !== "none") return null;
  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) return null;
  if (!redirectUris.every(isNativeRedirectUri)) return null;
  return { ...metadata, application_type: "native" };
}
