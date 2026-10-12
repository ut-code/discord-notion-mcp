import { AUTH_BASE_PATH, type Auth } from "./auth/auth";
import { clientIpFromForwardedFor, withClientIp } from "./lib/client-ip";
import { errorMessage } from "./lib/errors";
import { logError, type ErrorSink } from "./lib/log";

/** Handles the non-UI routes; null means the request belongs to the UI. */
export type HttpHandler = (request: Request, socketAddress?: () => string | null) => Promise<Response | null>;

export interface HttpDeps {
  auth: Pick<Auth, "handler">;
  mcpEndpoint: (request: Request) => Promise<Response>;
  /** Reverse proxies in front of the server; 0 uses the socket address. */
  trustedProxyCount: number;
  /** Unhandled request errors; defaults to stderr. */
  logError?: ErrorSink;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

/**
 * Applied to every response, UI included: no framing, no referrer leaving this origin
 * (same-origin requests keep a real Origin header, which "no-referrer" would turn into
 * `Origin: null` and break CSRF checks), and no caching unless the handler chose a policy.
 * Pages carry SvelteKit's full policy (`kit.csp` in svelte.config.js, which includes
 * frame-ancestors); every other response gets the frame-ancestors policy here.
 */
export function withSecurityHeaders(response: Response): Response {
  let target = response;
  try {
    target.headers.set("X-Frame-Options", "DENY");
  } catch {
    // Immutable headers (e.g. a fetched response): copy once, then set in place.
    target = new Response(response.body, response);
    target.headers.set("X-Frame-Options", "DENY");
  }
  const headers = target.headers;
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set("Referrer-Policy", "same-origin");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return target;
}

/** CSRF for the UI's form posts: state-changing requests must carry this origin. */
export function isCrossOriginWrite(request: Request, publicOrigin: string): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  return request.headers.get("origin") !== publicOrigin;
}

export function createHttpHandler(deps: HttpDeps): HttpHandler {
  const reportError = deps.logError ?? logError;

  const clientIp = (request: Request, socketAddress?: () => string | null): string | null => {
    if (deps.trustedProxyCount > 0) return clientIpFromForwardedFor(request.headers.get("x-forwarded-for"), deps.trustedProxyCount);
    return socketAddress?.() ?? null;
  };

  const route = async (request: Request, socketAddress?: () => string | null): Promise<Response | null> => {
    const { pathname } = new URL(request.url);
    const method = request.method;
    if (pathname === "/healthz") return method === "GET" || method === "HEAD" ? Response.json({ ok: true }) : notFound();
    if (pathname === "/mcp") return deps.mcpEndpoint(request);
    // OAuth discovery (RFC 8414 / RFC 9728 / OIDC) is served by the Better Auth
    // plugins' request hooks; they must be reachable at the host root.
    if (pathname.startsWith("/.well-known/")) {
      if (method !== "GET" && method !== "HEAD") return notFound();
      return deps.auth.handler(withClientIp(request, clientIp(request, socketAddress)));
    }
    if (pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
      if (method !== "GET" && method !== "POST") return notFound();
      return deps.auth.handler(withClientIp(request, clientIp(request, socketAddress)));
    }
    return null;
  };

  return async (request, socketAddress) => {
    try {
      const response = await route(request, socketAddress);
      return response ? withSecurityHeaders(response) : null;
    } catch (error) {
      reportError({ event: "http_error", path: new URL(request.url).pathname, error: errorMessage(error) });
      return withSecurityHeaders(Response.json({ error: "internal_error" }, { status: 500 }));
    }
  };
}
