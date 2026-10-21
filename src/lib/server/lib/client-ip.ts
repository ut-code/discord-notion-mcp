/**
 * Internal header carrying the resolved client IP to Better Auth (rate limiting,
 * session tracking). Requests handed to Better Auth's handler (http.ts) always carry
 * the server's value; the pages' direct API calls (getSession, signOut, getOAuthClientPublic)
 * keep the browser's headers, which is harmless as those neither rate-limit nor create sessions.
 */
export const CLIENT_IP_HEADER = "x-resolved-client-ip";

const IP_PATTERN = /^[0-9a-fA-F:.]+$/;

/**
 * Picks the client IP from X-Forwarded-For given the number of trusted reverse
 * proxies in front of the server. Each proxy appends the address it received the
 * request from, so the entry `trustedProxyCount` positions from the right is the
 * last address no client could forge. Returns null when the chain is too short.
 */
export function clientIpFromForwardedFor(header: string | null | undefined, trustedProxyCount: number): string | null {
  if (!header || trustedProxyCount < 1) return null;
  const hops = header
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const candidate = hops[hops.length - trustedProxyCount];
  return candidate && IP_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Returns a copy of the request whose CLIENT_IP_HEADER is exactly `ip`, or empty
 * when unknown (Better Auth treats an empty value as no IP). The header is never
 * deleted: Bun ignores an empty `headers` init and would keep the original ones.
 */
export function withClientIp(request: Request, ip: string | null): Request {
  const headers = new Headers(request.headers);
  headers.set(CLIENT_IP_HEADER, ip ?? "");
  return new Request(request, { headers });
}
