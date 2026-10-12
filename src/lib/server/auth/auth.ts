import type { Database } from "bun:sqlite";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { jwt } from "better-auth/plugins";
import type { Config } from "../config";
import { CLIENT_IP_HEADER } from "../lib/client-ip";
import { errorMessage } from "../lib/errors";
import { logError, logEvent, type LogSink } from "../lib/log";
import { CONSENT_PATH, NOT_MEMBER_PATH, SIGN_IN_PATH } from "../../paths";
import { withInferredApplicationType } from "./registration";

export const AUTH_BASE_PATH = "/api/auth";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Better Auth creates `string[]` columns as TEXT on SQLite but its migration
 * planner expects a JSON column type, so it warns about every such column on
 * each boot although the stored data is fine.
 */
const FALSE_POSITIVE_TYPE_WARNING = /has a different type in the database\. Expected (string|number)\[\] but got text\.?$/i;

function betterAuthLogger(reportEvent: LogSink, reportError: LogSink) {
  return (level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]): void => {
    if (level === "warn" && FALSE_POSITIVE_TYPE_WARNING.test(message)) return;
    const entry = {
      event: "better_auth",
      level,
      message,
      ...(args.length > 0 ? { details: args.map((arg) => (arg instanceof Error ? arg.message : arg)) } : {}),
    };
    if (level === "error") reportError(entry);
    else reportEvent(entry);
  };
}

export interface AuthDeps {
  config: Config;
  sqlite: Database;
  /** Whether the Better Auth user is linked to a Discord account that is a member of the guild. */
  isGuildMember: (userId: string) => Promise<boolean>;
  /** Defaults to stdout / stderr. */
  logEvent?: LogSink;
  logError?: LogSink;
}

function authOptions({ config, sqlite, isGuildMember, logEvent: reportEvent = logEvent, logError: reportError = logError }: AuthDeps) {
  return {
    appName: "Discord Notion MCP",
    baseURL: config.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.betterAuthSecret,
    database: sqlite,
    telemetry: { enabled: false },
    logger: { log: betterAuthLogger(reportEvent, reportError) },
    advanced: {
      // The app resolves the client IP from X-Forwarded-For (TRUSTED_PROXY_COUNT)
      // and hands it over in a header no client can set.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/oauth2/register") return;
        const body = withInferredApplicationType(ctx.body);
        if (body) return { context: { body } };
      }),
    },
    socialProviders: {
      discord: {
        clientId: config.discord.clientId,
        clientSecret: config.discord.clientSecret,
        disableDefaultScope: true,
        scope: ["identify"],
        // Better Auth requires an email on the user record; without the `email`
        // scope we store a unique, non-routable placeholder derived from the Discord id.
        mapProfileToUser: (profile: { id: string }) => ({
          email: `${profile.id}@users.discord.invalid`,
          emailVerified: false,
        }),
      },
    },
    plugins: [
      jwt({ jwt: { issuer: config.publicUrl } }),
      mcp({
        resource: config.mcpResource,
        loginPage: SIGN_IN_PATH,
        consentPage: CONSENT_PATH,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
        postLogin: {
          page: NOT_MEMBER_PATH,
          consentReferenceId: () => undefined,
          shouldRedirect: async ({ user }) => {
            try {
              return !(await isGuildMember(user.id));
            } catch (error) {
              reportError({ event: "membership_check_failed", error: errorMessage(error) });
              return true;
            }
          },
        },
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    ],
  } satisfies BetterAuthOptions;
}

function instantiate(options: ReturnType<typeof authOptions>) {
  return betterAuth(options);
}

export type Auth = ReturnType<typeof instantiate>;

/**
 * Creates or updates Better Auth's own tables first (so the container self-migrates
 * on boot and the instance's schema check sees the final schema), then the instance.
 */
export async function createAuth(deps: AuthDeps): Promise<Auth> {
  const options = authOptions(deps);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  return instantiate(options);
}
