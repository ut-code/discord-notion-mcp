import { isRecord } from "../../guards";
import { isLoopbackHost } from "../lib/loopback";

function isNativeRedirectUri(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  const url = URL.parse(uri);
  if (!url) return false;
  if (url.protocol === "https:") return false;
  if (url.protocol === "http:") return isLoopbackHost(url.hostname);
  return true;
}

/**
 * Some MCP clients register via DCR (RFC 7591) as public clients with loopback redirect
 * URIs but omit `application_type`. That field comes from OpenID Connect Dynamic Client
 * Registration, where it defaults to "web", and Better Auth rejects http loopback
 * redirects for web clients. Such clients are native apps per RFC 8252, so we fill in
 * `application_type: "native"` for them only.
 */
export function withInferredApplicationType(metadata: unknown): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null;
  if (metadata.application_type !== undefined) return null;
  if (metadata.token_endpoint_auth_method !== "none") return null;
  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) return null;
  if (!redirectUris.every(isNativeRedirectUri)) return null;
  return { ...metadata, application_type: "native" };
}
