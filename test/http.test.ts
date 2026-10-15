import { describe, expect, test } from "bun:test";
import type { Auth } from "../src/lib/server/auth/auth";
import { createHttpHandler, withSecurityHeaders } from "../src/lib/server/http";
import type { EventEntry } from "../src/lib/server/lib/log";
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
      publicOrigin: "http://x",
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
      publicOrigin: "http://x",
    });
    await http(new Request("http://x/api/auth/ok", { headers: { "x-forwarded-for": "6.6.6.6" } }), () => "192.0.2.1");
    expect(seen).toEqual(["192.0.2.1"]);
  });

  test("routes /mcp, /healthz and auth paths; everything else belongs to the UI", async () => {
    const http = createHttpHandler({
      auth: fakeAuth(async () => new Response("auth")),
      mcpEndpoint: async () => new Response("mcp"),
      trustedProxyCount: 0,
      publicOrigin: "http://x",
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
      publicOrigin: "http://x",
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

  // Per the Fetch spec, redirect and fetched responses have immutable headers (Node throws
  // TypeError on set; Bun currently does not), so the immutability is simulated here.
  const withFrozenHeaders = (response: Response, error: Error) => {
    Object.defineProperty(response.headers, "set", {
      value: () => {
        throw error;
      },
    });
    return response;
  };

  test("immutable responses are copied", () => {
    const frozen = withFrozenHeaders(Response.redirect("http://x/next", 302), new TypeError("immutable"));
    const res = withSecurityHeaders(frozen);
    expect(res).not.toBe(frozen);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://x/next");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("other failures while setting headers are not mistaken for immutability", () => {
    const broken = withFrozenHeaders(new Response("x"), new RangeError("unexpected"));
    expect(() => withSecurityHeaders(broken)).toThrow("unexpected");
  });
});

describe("CSRF", () => {
  const PUBLIC_ORIGIN = "https://mcp.example.com";
  const handler = (events: EventEntry[] = []) =>
    createHttpHandler({
      auth: fakeAuth(async () => new Response("auth")),
      mcpEndpoint: async () => new Response("mcp"),
      trustedProxyCount: 0,
      publicOrigin: PUBLIC_ORIGIN,
      logEvent: (entry) => events.push(entry),
    });
  const post = (path: string, origin: string | null) =>
    new Request(`${PUBLIC_ORIGIN}${path}`, { method: "POST", headers: origin ? { origin } : {} });

  test("UI writes must come from the public origin", async () => {
    const events: EventEntry[] = [];
    const http = handler(events);
    for (const path of ["/dashboard/grants?/create", "/theme"]) {
      const refused = (await http(post(path, "https://evil.example")))!;
      expect(refused.status).toBe(403);
      expect(refused.headers.get("x-frame-options")).toBe("DENY");
      expect((await http(post(path, null)))!.status).toBe(403);
      expect(await http(post(path, PUBLIC_ORIGIN))).toBeNull();
    }
    expect(await http(new Request(`${PUBLIC_ORIGIN}/dashboard`, { headers: { origin: "https://evil.example" } }))).toBeNull();
    expect(events[0]).toEqual({
      event: "cross_origin_write_refused",
      method: "POST",
      path: "/dashboard/grants",
      origin: "https://evil.example",
    });
    expect(events).toHaveLength(4);
  });

  test("MCP and OAuth clients post from other origins", async () => {
    const http = handler();
    expect(await (await http(post("/mcp", "https://claude.ai")))!.text()).toBe("mcp");
    expect(await (await http(post("/api/auth/oauth2/token", null)))!.text()).toBe("auth");
  });
});
