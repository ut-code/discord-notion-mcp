import { describe, expect, test } from "bun:test";
import type { Auth } from "../src/lib/server/auth/auth";
import { createHttpHandler, isCrossOriginWrite, withSecurityHeaders } from "../src/lib/server/http";
import { clientIpFromForwardedFor, CLIENT_IP_HEADER, withClientIp } from "../src/lib/server/lib/client-ip";

const fakeAuth = (handler: (request: Request) => Promise<Response>) => ({ handler }) as unknown as Pick<Auth, "handler">;

describe("clientIpFromForwardedFor", () => {
  test("takes the entry appended by the outermost trusted proxy", () => {
    expect(clientIpFromForwardedFor("203.0.113.7", 1)).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("6.6.6.6, 203.0.113.7", 1)).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("6.6.6.6, 203.0.113.7, 10.0.0.2", 2)).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("2001:db8::1", 1)).toBe("2001:db8::1");
  });

  test("returns null when the chain is too short, empty, garbage or untrusted", () => {
    expect(clientIpFromForwardedFor("203.0.113.7", 2)).toBeNull();
    expect(clientIpFromForwardedFor("", 1)).toBeNull();
    expect(clientIpFromForwardedFor(null, 1)).toBeNull();
    expect(clientIpFromForwardedFor("not-an-ip", 1)).toBeNull();
    expect(clientIpFromForwardedFor("203.0.113.7", 0)).toBeNull();
  });

  test("withClientIp replaces any client-supplied header", () => {
    const spoofed = new Request("http://x/", { headers: { [CLIENT_IP_HEADER]: "6.6.6.6" } });
    expect(withClientIp(spoofed, "203.0.113.7").headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
    expect(withClientIp(spoofed, null).headers.get(CLIENT_IP_HEADER)).toBe("");
  });
});

describe("http handler", () => {
  test("Better Auth requests carry the client IP resolved from X-Forwarded-For", async () => {
    const seen: Array<string | null> = [];
    const http = createHttpHandler({
      auth: fakeAuth(async (request) => (seen.push(request.headers.get(CLIENT_IP_HEADER)), new Response("ok"))),
      mcpEndpoint: async () => new Response(),
      trustedProxyCount: 1,
    });
    await http(
      new Request("http://x/api/auth/ok", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7", [CLIENT_IP_HEADER]: "1.1.1.1" } }),
    );
    await http(new Request("http://x/.well-known/oauth-authorization-server", { headers: { [CLIENT_IP_HEADER]: "1.1.1.1" } }));
    expect(seen).toEqual(["203.0.113.7", ""]);
  });

  test("without trusted proxies the socket address is used", async () => {
    const seen: Array<string | null> = [];
    const http = createHttpHandler({
      auth: fakeAuth(async (request) => (seen.push(request.headers.get(CLIENT_IP_HEADER)), new Response("ok"))),
      mcpEndpoint: async () => new Response(),
      trustedProxyCount: 0,
    });
    await http(new Request("http://x/api/auth/ok", { headers: { "x-forwarded-for": "6.6.6.6" } }), () => "192.0.2.1");
    expect(seen).toEqual(["192.0.2.1"]);
  });

  test("routes /mcp, /healthz and auth paths; everything else belongs to the UI", async () => {
    const http = createHttpHandler({
      auth: fakeAuth(async () => new Response("auth")),
      mcpEndpoint: async () => new Response("mcp"),
      trustedProxyCount: 0,
    });
    expect(await (await http(new Request("http://x/mcp", { method: "DELETE" })))!.text()).toBe("mcp");
    expect(await (await http(new Request("http://x/healthz")))!.json()).toEqual({ ok: true });
    expect(await (await http(new Request("http://x/api/auth/session")))!.text()).toBe("auth");
    expect((await http(new Request("http://x/api/auth/session", { method: "PUT" })))!.status).toBe(404);
    expect((await http(new Request("http://x/.well-known/x", { method: "POST" })))!.status).toBe(404);
    expect(await http(new Request("http://x/dashboard"))).toBeNull();
    expect(await http(new Request("http://x/api/authx"))).toBeNull();
  });

  test("errors become a JSON 500 carrying the framing and caching headers", async () => {
    const errors: unknown[] = [];
    const http = createHttpHandler({
      auth: fakeAuth(async () => new Response()),
      mcpEndpoint: async () => {
        throw new Error("kaboom");
      },
      trustedProxyCount: 0,
      logError: (entry) => errors.push(entry),
    });
    const res = (await http(new Request("http://x/mcp", { method: "POST" })))!;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(errors).toEqual([{ event: "http_error", path: "/mcp", error: "kaboom" }]);
  });
});

describe("security headers", () => {
  test("a cache policy chosen by the handler is kept", () => {
    const res = withSecurityHeaders(new Response("ok", { headers: { "Cache-Control": "public, max-age=60" } }));
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("immutable responses are copied", async () => {
    const immutable = Response.redirect("http://x/next", 302);
    const res = withSecurityHeaders(immutable);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://x/next");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("CSRF", () => {
  const post = (origin: string | null) =>
    new Request("http://x/dashboard/grants?/create", { method: "POST", headers: origin ? { origin } : {} });

  test("state-changing requests must come from the public origin", () => {
    expect(isCrossOriginWrite(post("http://evil.example"), "https://mcp.example.com")).toBe(true);
    expect(isCrossOriginWrite(post(null), "https://mcp.example.com")).toBe(true);
    expect(isCrossOriginWrite(post("https://mcp.example.com"), "https://mcp.example.com")).toBe(false);
    expect(isCrossOriginWrite(new Request("http://x/dashboard"), "https://mcp.example.com")).toBe(false);
  });
});
