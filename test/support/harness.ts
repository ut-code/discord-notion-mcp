import { expect } from "bun:test";
import { makeSignature } from "better-auth/crypto";
import { composeServer, type AppServer, type ComposeOptions } from "../../src/lib/server/compose";
import { loadConfig } from "../../src/lib/server/config";
import { openDatabase } from "../../src/lib/server/db/client";
import type { ErrorEntry, EventEntry, ToolCallLogEntry } from "../../src/lib/server/lib/log";
import { extractSignedOAuthQuery } from "../../src/lib/server/dashboard/oauth-query";
import { FakeDiscordApi, GUILD_ID } from "./fakes";
import { FakeNotionApi } from "./notion-fakes";

const SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e";
export const REDIRECT_URI = "http://localhost:33418/callback";
const CODE_VERIFIER = "e2e-code-verifier-e2e-code-verifier-e2e-code-verifier";

/**
 * An app server listening on a random local port, backed by fakes and an in-memory
 * database. It serves the non-UI routes (http.ts); UI pages are covered by the admin module tests.
 */
export interface Harness {
  base: string;
  resource: string;
  server: AppServer;
  discord: FakeDiscordApi;
  notion: FakeNotionApi;
  toolLogs: ToolCallLogEntry[];
  events: EventEntry[];
  errors: ErrorEntry[];
  stop(): Promise<void>;
}

export interface HarnessOptions {
  discord?: FakeDiscordApi;
  notion?: FakeNotionApi;
  toolRateLimit?: ComposeOptions["toolRateLimit"];
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  let handler: AppServer["http"] = async () => new Response("starting", { status: 503 });
  const listener = Bun.serve({
    port: 0,
    fetch: async (request, bun) =>
      (await handler(request, () => bun.requestIP(request)?.address ?? null)) ?? Response.json({ error: "not_found" }, { status: 404 }),
  });
  const base = `http://localhost:${listener.port}`;
  const discord = options.discord ?? new FakeDiscordApi();
  const notion = options.notion ?? new FakeNotionApi();
  const toolLogs: ToolCallLogEntry[] = [];
  const events: EventEntry[] = [];
  const errors: ErrorEntry[] = [];
  const config = loadConfig({
    PUBLIC_URL: base,
    BETTER_AUTH_SECRET: SECRET,
    DISCORD_CLIENT_ID: "123456789012345678",
    DISCORD_CLIENT_SECRET: "x",
    DISCORD_BOT_TOKEN: "x",
    DISCORD_GUILD_ID: GUILD_ID,
  });
  const server = await composeServer(config, {
    discordApi: discord,
    notionApi: notion,
    database: openDatabase(":memory:"),
    logToolCall: (entry) => toolLogs.push(entry),
    logEvent: (entry) => events.push(entry),
    logError: (entry) => errors.push(entry),
    toolRateLimit: options.toolRateLimit,
  });
  handler = server.http;
  return { base, resource: config.mcpResource, server, discord, notion, toolLogs, events, errors, stop: () => listener.stop(true) };
}

/** Creates a browser session for an existing Better Auth user and returns its cookie. */
export async function newSessionCookie(h: Harness, userId: string): Promise<string> {
  const ctx = await h.server.auth.$context;
  const session = await ctx.internalAdapter.createSession(userId);
  const signed = `${session.token}.${await makeSignature(session.token, SECRET)}`;
  return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
}

/** Simulates a Discord login: user + linked account on first login, then a new session. */
export async function signIn(h: Harness, discordUserId: string): Promise<{ userId: string; cookie: string }> {
  const ctx = await h.server.auth.$context;
  const email = `${discordUserId}@users.discord.invalid`;
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  if (existing) return { userId: existing.user.id, cookie: await newSessionCookie(h, existing.user.id) };
  const user = await ctx.internalAdapter.createUser(
    { name: `user-${discordUserId}`, email, emailVerified: false },
    { method: "oauth", oauth: { providerId: "discord" } },
  );
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "discord", accountId: discordUserId });
  return { userId: user.id, cookie: await newSessionCookie(h, user.id) };
}

export async function sessionCookieFor(h: Harness, discordUserId: string): Promise<string> {
  return (await signIn(h, discordUserId)).cookie;
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function registerClient(h: Harness): Promise<string> {
  const res = await fetch(`${h.base}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "E2E CLI",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

export async function authorize(h: Harness, clientId: string, cookie: string): Promise<Response> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: await codeChallenge(CODE_VERIFIER),
    code_challenge_method: "S256",
    state: "e2e-state",
    resource: h.resource,
  });
  return fetch(`${h.base}/api/auth/oauth2/authorize?${params}`, { headers: { cookie }, redirect: "manual" });
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCode(h: Harness, clientId: string, code: string): Promise<TokenSet> {
  const res = await fetch(`${h.base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: CODE_VERIFIER,
      resource: h.resource,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as TokenSet;
}

export async function refreshTokens(h: Harness, clientId: string, refreshToken: string): Promise<Response> {
  return fetch(`${h.base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: h.resource }),
  });
}

/** Runs authorize (+ consent when asked) and exchanges the code for tokens. */
export async function issueTokens(h: Harness, clientId: string, cookie: string): Promise<TokenSet> {
  const first = await authorize(h, clientId, cookie);
  expect(first.status).toBe(302);
  let redirect = new URL(first.headers.get("location")!, h.base);
  if (redirect.pathname === "/consent") {
    const consent = await fetch(`${h.base}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: h.base },
      body: JSON.stringify({ accept: true, oauth_query: extractSignedOAuthQuery(redirect.search) }),
    });
    expect(consent.status).toBe(200);
    redirect = new URL(((await consent.json()) as { url: string }).url);
  }
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
  // Clients such as Codex validate RFC 9207 `iss` against the discovered issuer.
  const iss = redirect.searchParams.get("iss");
  if (iss !== null) {
    const metadata = (await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json()) as { issuer: string };
    expect(iss).toBe(metadata.issuer);
  }
  return exchangeCode(h, clientId, redirect.searchParams.get("code")!);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions dig into arbitrary JSON-RPC results
type McpJson = any;

export async function mcpCall(h: Harness, token: string, body: unknown): Promise<{ status: number; json: McpJson; headers: Headers }> {
  const res = await fetch(`${h.base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  const payload = res.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("")
    : text;
  return { status: res.status, json: JSON.parse(payload), headers: res.headers };
}
