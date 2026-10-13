import { z } from "zod";
import { isLoopbackHost } from "./lib/loopback";
import { snowflakeSchema } from "./lib/snowflake";

const publicUrl = z
  .url()
  .transform((value) => value.replace(/\/+$/, ""))
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.pathname !== "/" && url.pathname !== "") {
      ctx.addIssue({ code: "custom", message: "must be an origin without a path (e.g. https://mcp.example.com)" });
    }
    if (url.search || url.hash) {
      ctx.addIssue({ code: "custom", message: "must not contain a query or fragment" });
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      ctx.addIssue({ code: "custom", message: "must use https (http is allowed only for localhost)" });
    }
  });

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

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const normalized = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value === "" ? undefined : value]));
  const parsed = EnvSchema.safeParse(normalized);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      const message = issue.code === "invalid_type" && issue.input === undefined ? "is required" : issue.message;
      return `  - ${key}: ${message}`;
    });
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
