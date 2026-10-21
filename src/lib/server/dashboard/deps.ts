import type { Auth } from "../auth/auth";
import type { DiscordIdentityStore } from "../auth/identity";
import type { TokenRevocationService } from "../auth/revocation";
import type { LoginUserStore } from "../auth/users";
import type { GuildDirectory } from "../discord/directory";
import type { ErrorSink, EventSink } from "../lib/log";
import type { ToolListing } from "../mcp/tool-listing";
import type { NotionAuditService } from "../notion/changes/audit-service";
import type { GrantStore } from "../permissions/grants";
import type { PermissionResolver } from "../permissions/resolver";
import type { ToolCallStore } from "../usage/tool-calls";
import type { UsageStats } from "../usage/usage-stats";
import type { MemberRoster } from "./member-roster";
import type { SubjectResolver } from "./subjects";

/** Everything the browser-facing pages (dashboard, sign-in, consent) read or change. */
export interface DashboardDeps {
  auth: Auth;
  /** Shown on the connection page for registering MCP clients. */
  mcpUrl: string;
  identity: Pick<DiscordIdentityStore, "discordUserIdForUser">;
  resolver: Pick<PermissionResolver, "resolve" | "accessOf">;
  /** Cached guild/member lookups. */
  directory: GuildDirectory;
  subjects: SubjectResolver;
  /** The guild's members (briefly cached): the grant form, and the users page's names and roles. */
  members: Pick<MemberRoster, "roster">;
  grants: GrantStore;
  users: LoginUserStore;
  audit: NotionAuditService;
  /** Usage statistics (tool calls, Notion writes). */
  usage: UsageStats;
  /** The kept tool calls themselves, for the call history. */
  calls: Pick<ToolCallStore, "list" | "callers">;
  /** Every MCP tool as clients list it: the tools page, and the permission groups of statistics. */
  tools: readonly ToolListing[];
  revocation: TokenRevocationService;
  /** Admin actions. */
  log: EventSink;
  /** Lookup and sign-out failures. */
  logError: ErrorSink;
}
