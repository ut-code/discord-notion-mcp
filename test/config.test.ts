import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/lib/server/config";

const ENV = {
  PUBLIC_URL: "https://mcp.example.com",
  BETTER_AUTH_SECRET: "s".repeat(32),
  DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: "123456789012345678",
};

function errorOf(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("PUBLIC_URL", () => {
  test("is reduced to the origin clients derive", () => {
    for (const value of [
      "https://mcp.example.com/",
      "https://MCP.Example.com",
      "https://mcp.example.com:443/",
      "https://mcp.example.com/?",
      "https://mcp.example.com/#",
    ]) {
      expect(loadConfig({ ...ENV, PUBLIC_URL: value })).toMatchObject({
        publicUrl: "https://mcp.example.com",
        mcpResource: "https://mcp.example.com/mcp",
      });
    }
    expect(loadConfig({ ...ENV, PUBLIC_URL: "http://localhost:3000/" }).publicUrl).toBe("http://localhost:3000");
  });

  test("rejects paths, queries, credentials and plain http off loopback", () => {
    expect(errorOf({ ...ENV, PUBLIC_URL: "https://example.com/app" })).toContain("must be an origin without a path");
    expect(errorOf({ ...ENV, PUBLIC_URL: "https://example.com/?a=1" })).toContain("must not contain a query or fragment");
    expect(errorOf({ ...ENV, PUBLIC_URL: "https://user:pass@example.com" })).toContain("must not contain credentials");
    expect(errorOf({ ...ENV, PUBLIC_URL: "http://localhost.evil.example" })).toContain("must use https");
  });
});

describe("errors", () => {
  test("say what is wrong without echoing values", () => {
    const message = errorOf({
      ...ENV,
      PUBLIC_URL: undefined,
      PORT: "not-a-port",
      BETTER_AUTH_SECRET: "too-short-secret",
      DISCORD_GUILD_ID: "guild-secret",
      TRUSTED_PROXY_COUNT: "1.5",
    });
    expect(message).toBe(
      [
        "Invalid environment configuration:",
        "  - PUBLIC_URL: is required",
        "  - PORT: must be a number",
        "  - BETTER_AUTH_SECRET: must be at least 32 characters (e.g. `openssl rand -base64 32`)",
        "  - DISCORD_GUILD_ID: must be a Discord id (numeric snowflake)",
        "  - TRUSTED_PROXY_COUNT: must be an integer",
      ].join("\n"),
    );
    for (const value of ["not-a-port", "too-short-secret", "guild-secret"]) expect(message).not.toContain(value);
  });

  test("empty values count as unset, so defaults apply", () => {
    expect(loadConfig({ ...ENV, PORT: "", NOTION_TOKEN: "" })).toMatchObject({ port: 3000, notion: null });
  });
});
