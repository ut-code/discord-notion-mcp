import { z, type core } from "zod";
import { isLoopbackHost } from "./lib/loopback";
import { snowflakeSchema } from "./lib/snowflake";

/** An origin; normalized by URL (lower-case host, no default port or trailing slash) so it matches what clients derive. */
const publicUrl = z
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (!/^\/*$/.test(url.pathname)) {
      ctx.addIssue({ code: "custom", message: "must be an origin without a path (e.g. https://mcp.example.com)" });
    }
    if (url.search || url.hash) {
      ctx.addIssue({ code: "custom", message: "must not contain a query or fragment" });
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: "custom", message: "must not contain credentials" });
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      ctx.addIssue({ code: "custom", message: "must use https (http is allowed only for localhost)" });
    }
  })
  .transform((value) => new URL(value).origin);

const EnvSchema = z.object({
  PUBLIC_URL: publicUrl,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("./data/app.db"),
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters (e.g. `openssl rand -base64 32`)"),
  DISCORD_CLIENT_ID: snowflakeSchema,
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: snowflakeSchema,
  NOTION_TOKEN: z.string().min(1).optional(),
  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(10).default(1),
});

export interface Config {
  publicUrl: string;
  mcpResource: string;
  port: number;
  databasePath: string;
  betterAuthSecret: string;
  discord: {
    clientId: string;
    clientSecret: string;
    botToken: string;
    guildId: string;
  };
  /** Null when NOTION_TOKEN is not set; the Notion tools are then not registered. */
  notion: { token: string } | null;
  /** Reverse proxies appending to X-Forwarded-For; 0 trusts the socket address only. */
  trustedProxyCount: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Wording for Zod's built-in checks that never echoes the value, which may be a secret.
 * Messages written in EnvSchema take precedence over this map.
 */
function envIssueMessage(issue: core.$ZodRawIssue): string {
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined) return "is required";
      return issue.expected === "int" ? "must be an integer" : `must be a ${issue.expected}`;
    case "too_small":
      return issue.origin === "string"
        ? `must be at least ${String(issue.minimum)} characters`
        : `must be at least ${String(issue.minimum)}`;
    case "too_big":
      return issue.origin === "string" ? `must be at most ${String(issue.maximum)} characters` : `must be at most ${String(issue.maximum)}`;
    case "invalid_format":
      return `must be a valid ${issue.format}`;
    default:
      return "is invalid";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const normalized = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value === "" ? undefined : value]));
  const parsed = EnvSchema.safeParse(normalized, { error: envIssueMessage });
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  return {
    publicUrl: e.PUBLIC_URL,
    mcpResource: `${e.PUBLIC_URL}/mcp`,
    port: e.PORT,
    databasePath: e.DATABASE_PATH,
    betterAuthSecret: e.BETTER_AUTH_SECRET,
    discord: {
      clientId: e.DISCORD_CLIENT_ID,
      clientSecret: e.DISCORD_CLIENT_SECRET,
      botToken: e.DISCORD_BOT_TOKEN,
      guildId: e.DISCORD_GUILD_ID,
    },
    notion: e.NOTION_TOKEN ? { token: e.NOTION_TOKEN } : null,
    trustedProxyCount: e.TRUSTED_PROXY_COUNT,
  };
}
