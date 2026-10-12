import type { Auth } from "../auth/auth";
import type { DiscordIdentityStore } from "../auth/identity";
import type { TokenRevocationService } from "../auth/revocation";
import type { LoginUserStore } from "../auth/users";
import type { DiscordApi } from "../discord/api";
import type { GuildDirectory } from "../discord/directory";
import type { ErrorSink, EventSink } from "../lib/log";
import type { NotionAuditService } from "../notion/changes/audit-service";
import type { GrantStore } from "../permissions/grants";
import type { PermissionResolver } from "../permissions/resolver";
import type { UsageStats } from "../usage/usage-stats";
import type { SubjectResolver } from "./subjects";

/** Everything the browser-facing pages (dashboard, sign-in, consent) read or change. */
export interface DashboardDeps {
  auth: Auth;
  /** Shown on the connection page for registering MCP clients. */
  mcpUrl: string;
  identity: Pick<DiscordIdentityStore, "discordUserIdForUser">;
  resolver: Pick<PermissionResolver, "resolve">;
  /** Cached guild/member lookups. */
  directory: GuildDirectory;
  discord: Pick<DiscordApi, "searchMembers" | "fetchUser">;
  subjects: SubjectResolver;
  grants: GrantStore;
  users: LoginUserStore;
  audit: NotionAuditService;
  /** Usage statistics (tool calls, Notion writes). */
  usage: UsageStats;
  revocation: TokenRevocationService;
  notionEnabled: boolean;
  /** Admin actions. */
  log: EventSink;
  /** Lookup and sign-out failures. */
  logError: ErrorSink;
}
