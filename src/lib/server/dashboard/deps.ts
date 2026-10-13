import type { Auth } from "../auth/auth";
import type { DiscordIdentityStore } from "../auth/identity";
import type { TokenRevocationService } from "../auth/revocation";
import type { LoginUserStore } from "../auth/users";
import type { GuildDirectory } from "../discord/directory";
import type { ErrorSink, EventSink } from "../lib/log";
import type { NotionAuditService } from "../notion/changes/audit-service";
import type { GrantStore } from "../permissions/grants";
import type { Permission } from "../permissions/permissions";
import type { PermissionResolver } from "../permissions/resolver";
import type { UsageStats } from "../usage/usage-stats";
import type { MemberSearch } from "./member-search";
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
  subjects: SubjectResolver;
  /** Grant form member search (briefly cached). */
  memberSearch: Pick<MemberSearch, "search">;
  grants: GrantStore;
  users: LoginUserStore;
  audit: NotionAuditService;
  /** Usage statistics (tool calls, Notion writes). */
  usage: UsageStats;
  /** Permission each MCP tool requires; groups usage in the stats chart. */
  toolPermissions: ReadonlyMap<string, Permission>;
  revocation: TokenRevocationService;
  notionEnabled: boolean;
  /** Admin actions. */
  log: EventSink;
  /** Lookup and sign-out failures. */
  logError: ErrorSink;
}
