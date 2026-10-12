import type { AdminDeps } from "./admin/deps";
import { UsageStats } from "./admin/stats";
import { SubjectResolver } from "./admin/subjects";
import { createAuth, type Auth } from "./auth/auth";
import { DiscordIdentityStore } from "./auth/identity";
import { TokenRevocationService } from "./auth/revocation";
import { LoginUserStore } from "./auth/users";
import type { Config } from "./config";
import { openDatabase, runAppMigrations, type DatabaseHandle } from "./db/client";
import { ChannelAccess, ChannelDirectory } from "./discord/access";
import { RestDiscordApi, type DiscordApi } from "./discord/api";
import { CachedGuildDirectory } from "./discord/directory";
import { createDiscordTools } from "./discord/tools";
import { createHttpHandler, type HttpHandler } from "./http";
import { logError, logEvent, type ErrorSink, type EventSink } from "./lib/log";
import { createMcpEndpoint } from "./mcp/endpoint";
import type { AnyToolDefinition } from "./mcp/registry";
import type { McpServerDeps } from "./mcp/server";
import { SdkNotionApi, type NotionApi } from "./notion/client/api";
import { NotionAuditService } from "./notion/changes/audit-service";
import { NotionAuditStore } from "./notion/changes/audit-store";
import { NotionWriteService } from "./notion/changes/write-service";
import { createNotionChangeTools, createNotionTools } from "./notion/tools";
import { GrantStore } from "./permissions/grants";
import { PermissionResolver } from "./permissions/resolver";
import { startToolCallRetention, ToolCallStore } from "./usage/tool-calls";

export interface ComposeOptions {
  discordApi?: DiscordApi;
  /** Overrides the SDK-backed client; also enables Notion when NOTION_TOKEN is unset (tests). */
  notionApi?: NotionApi;
  database?: DatabaseHandle;
  logToolCall?: McpServerDeps["log"];
  /** Admin actions (grant changes, revocations, reverts) and startup maintenance; defaults to stdout. */
  logEvent?: EventSink;
  /** Unexpected failures (request errors, lookups, tool crashes); defaults to stderr. */
  logError?: ErrorSink;
  /** Overrides the per-user tool call rate limit (tests). */
  toolRateLimit?: McpServerDeps["rateLimit"];
  /** Overrides usage recording (tests); defaults to the tool_call table. */
  recordToolCall?: McpServerDeps["record"];
}

export interface ComposedServer {
  /** Non-UI routes: /mcp, /api/auth/*, /.well-known/*, /healthz. */
  http: HttpHandler;
  /** Data and actions of the browser pages. */
  admin: AdminDeps;
  auth: Auth;
  database: DatabaseHandle;
  grants: GrantStore;
  tools: AnyToolDefinition[];
  notionEnabled: boolean;
  /** Audit list/detail always work; revert needs Notion to be enabled. */
  notionAudit: NotionAuditService;
  revocation: TokenRevocationService;
  toolCalls: ToolCallStore;
  publicUrl: string;
  /** Unexpected request failures. */
  logError: ErrorSink;
}

/** Wires every component together and runs both migration sets. */
export async function composeServer(config: Config, options: ComposeOptions = {}): Promise<ComposedServer> {
  const database = options.database ?? openDatabase(config.databasePath);
  runAppMigrations(database.db);
  const reportEvent = options.logEvent ?? logEvent;
  const reportError = options.logError ?? logError;

  const discord = options.discordApi ?? new RestDiscordApi(config.discord.botToken, config.discord.guildId);
  const directory = new CachedGuildDirectory(discord);
  const grants = new GrantStore(database.db);
  const resolver = new PermissionResolver(directory, grants);
  const identity = new DiscordIdentityStore(database.db);

  const isGuildMember = async (userId: string): Promise<boolean> => {
    const discordUserId = await identity.discordUserIdForUser(userId);
    if (!discordUserId) return false;
    return (await directory.fetchMember(discordUserId)) !== null;
  };

  const auth = await createAuth({ config, sqlite: database.sqlite, isGuildMember, logError: reportError });

  const channels = new ChannelDirectory(discord);
  const notion = options.notionApi ?? (config.notion ? new SdkNotionApi(config.notion.token) : null);
  const auditStore = new NotionAuditStore(database.db);
  const notionAudit = new NotionAuditService(auditStore, notion);
  const interrupted = await notionAudit.failInterruptedWrites();
  if (interrupted > 0) reportEvent({ event: "audit_pending_marked_failed", count: interrupted });
  const tools: AnyToolDefinition[] = [
    ...createDiscordTools({
      api: discord,
      access: new ChannelAccess(discord, channels, config.discord.guildId),
      channels,
      guildId: config.discord.guildId,
    }),
    ...(notion
      ? [
          ...createNotionTools({ api: notion, writes: new NotionWriteService(notion, auditStore) }),
          ...createNotionChangeTools({ audit: notionAudit, publicUrl: config.publicUrl }),
        ]
      : []),
  ];

  const revocation = new TokenRevocationService(database.db);
  const toolCalls = new ToolCallStore(database.db);
  startToolCallRetention({ store: toolCalls, log: reportEvent, logError: reportError });
  const admin: AdminDeps = {
    auth,
    mcpUrl: config.mcpResource,
    identity,
    resolver,
    directory,
    discord,
    subjects: new SubjectResolver(directory, discord, reportError),
    grants,
    users: new LoginUserStore(database.db),
    audit: notionAudit,
    usage: new UsageStats(database.db),
    revocation,
    notionEnabled: notion !== null,
    log: reportEvent,
    logError: reportError,
  };

  const http = createHttpHandler({
    auth,
    mcpEndpoint: createMcpEndpoint({
      auth,
      resource: config.mcpResource,
      issuer: config.publicUrl,
      discordUserIdFromClaims: (claims) => identity.discordUserIdFromClaims(claims),
      resolveAccess: (discordUserId) => resolver.resolve(discordUserId),
      isTokenRevoked: (userId, issuedAt) => revocation.isRevoked(userId, issuedAt),
      tools,
      log: options.logToolCall,
      record: options.recordToolCall ?? ((entry) => toolCalls.record(entry)),
      logError: reportError,
      rateLimit: options.toolRateLimit,
    }),
    trustedProxyCount: config.trustedProxyCount,
    logError: reportError,
  });

  return {
    http,
    admin,
    auth,
    database,
    grants,
    tools,
    notionEnabled: notion !== null,
    notionAudit,
    revocation,
    toolCalls,
    publicUrl: config.publicUrl,
    logError: reportError,
  };
}
