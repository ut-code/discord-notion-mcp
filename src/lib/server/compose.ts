import { createAuth, type Auth } from "./auth/auth";
import { startClientCleanup } from "./auth/client-cleanup";
import { DiscordIdentityStore } from "./auth/identity";
import { TokenRevocationService } from "./auth/revocation";
import { LoginUserStore } from "./auth/users";
import type { Config } from "./config";
import type { DashboardDeps } from "./dashboard/deps";
import { MemberRoster } from "./dashboard/member-roster";
import { SubjectResolver } from "./dashboard/subjects";
import { openDatabase, runAppMigrations, type DatabaseHandle } from "./db/client";
import { ChannelAccess, ChannelDirectory } from "./discord/access";
import { RestDiscordApi, type DiscordApi } from "./discord/api";
import { CachedGuildDirectory } from "./discord/directory";
import { createDiscordTools } from "./discord/tools";
import { createHttpHandler, withSecurityHeaders, type HttpHandler } from "./http";
import { logError, logEvent, type ErrorSink, type EventSink } from "./lib/log";
import { createMcpEndpoint } from "./mcp/endpoint";
import type { AnyToolDefinition } from "./mcp/registry";
import type { McpServerDeps } from "./mcp/server";
import { toolListing } from "./mcp/tool-listing";
import { SdkNotionApi, type NotionApi } from "./notion/client/api";
import { NotionAuditService, startInterruptedWriteSweep } from "./notion/changes/audit-service";
import { NotionAuditStore } from "./notion/changes/audit-store";
import { NotionWriteService } from "./notion/changes/write-service";
import { createNotionChangeTools, createNotionTools } from "./notion/tools";
import { GrantStore } from "./permissions/grants";
import { PermissionResolver } from "./permissions/resolver";
import { startToolCallRetention, ToolCallStore } from "./usage/tool-calls";
import { UsageStats } from "./usage/usage-stats";

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
  /**
   * Other addresses of this same server whose pages may write, besides PUBLIC_URL (the preview
   * is opened both at localhost and through a proxy). Production serves one address and sets none.
   */
  otherOrigins?: readonly string[];
}

export interface AppServer {
  /** Runs before SvelteKit: /mcp, /api/auth/*, /.well-known/*, /healthz, and the UI's CSRF check. */
  http: HttpHandler;
  /** The security headers of every response (http.ts), for the responses SvelteKit resolves. */
  withSecurityHeaders: (response: Response) => Response;
  /** Data and actions of the browser pages. */
  dashboard: DashboardDeps;
  auth: Auth;
  database: DatabaseHandle;
  grants: GrantStore;
  tools: AnyToolDefinition[];
  notionEnabled: boolean;
  /** Audit list/detail always work; revert needs Notion to be enabled. */
  notionAudit: NotionAuditService;
  revocation: TokenRevocationService;
  toolCalls: ToolCallStore;
  /** Unexpected request failures. */
  logError: ErrorSink;
  /** Stops the periodic tasks (sweeps and cleanups); the server otherwise runs until the process exits. */
  stop: () => void;
}

/** Wires every component together and runs both migration sets. */
export async function composeServer(config: Config, options: ComposeOptions = {}): Promise<AppServer> {
  const database = options.database ?? openDatabase(config.databasePath);
  runAppMigrations(database.db);
  const reportEvent = options.logEvent ?? logEvent;
  const reportError = options.logError ?? logError;

  const discord = options.discordApi ?? new RestDiscordApi(config.discord.botToken, config.discord.guildId);
  // A separate client, so a long rate limit fails tool calls at once without failing sign-in.
  const discordForTools =
    options.discordApi ?? new RestDiscordApi(config.discord.botToken, config.discord.guildId, { failFastOnRateLimit: true });
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

  const channels = new ChannelDirectory(discordForTools);
  const notion = options.notionApi ?? (config.notion ? new SdkNotionApi(config.notion.token) : null);
  const auditStore = new NotionAuditStore(database.db);
  const notionAudit = new NotionAuditService(auditStore, notion, reportError);
  const stopTasks = [startInterruptedWriteSweep({ audit: notionAudit, log: reportEvent, logError: reportError })];
  const tools: AnyToolDefinition[] = [
    ...createDiscordTools({
      api: discordForTools,
      access: new ChannelAccess(discordForTools, channels, config.discord.guildId),
      channels,
      guildId: config.discord.guildId,
    }),
    ...(notion
      ? [
          ...createNotionTools({ api: notion, writes: new NotionWriteService(notion, auditStore, reportError) }),
          ...createNotionChangeTools({ audit: notionAudit, publicUrl: config.publicUrl }),
        ]
      : []),
  ];

  const revocation = new TokenRevocationService(database.db);
  const toolCalls = new ToolCallStore(database.db);
  stopTasks.push(
    startToolCallRetention({ store: toolCalls, log: reportEvent, logError: reportError }),
    startClientCleanup({ db: database.db, log: reportEvent, logError: reportError }),
  );
  const subjects = new SubjectResolver(directory, discord, reportError);
  const dashboard: DashboardDeps = {
    auth,
    mcpUrl: config.mcpResource,
    identity,
    resolver,
    directory,
    subjects,
    members: new MemberRoster(discord, subjects),
    grants,
    users: new LoginUserStore(database.db),
    audit: notionAudit,
    usage: new UsageStats(database.db),
    calls: toolCalls,
    tools: tools.map(toolListing),
    revocation,
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
    publicOrigin: new URL(config.publicUrl).origin,
    otherOrigins: options.otherOrigins,
    logEvent: reportEvent,
    logError: reportError,
  });

  return {
    http,
    withSecurityHeaders: (response) => withSecurityHeaders(response, config.publicUrl.startsWith("https:")),
    dashboard,
    auth,
    database,
    grants,
    tools,
    notionEnabled: notion !== null,
    notionAudit,
    revocation,
    toolCalls,
    logError: reportError,
    stop: () => {
      for (const stopTask of stopTasks) stopTask();
    },
  };
}
