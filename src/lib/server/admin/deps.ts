import type { Auth } from "../auth/auth";
import type { OAuthClientNames } from "../auth/clients";
import type { DiscordIdentityStore } from "../auth/identity";
import type { TokenRevocationService } from "../auth/revocation";
import type { LoginUserStore } from "../auth/users";
import type { GrantStore } from "../authz/grants";
import type { PermissionResolver } from "../authz/resolver";
import type { DiscordApi } from "../discord/api";
import type { GuildDirectory } from "../discord/directory";
import type { LogSink } from "../lib/log";
import type { NotionAuditService } from "../notion/changes/audit-service";
import type { UsageStats } from "./stats";
import type { SubjectResolver } from "./subjects";

/** Everything the browser-facing pages (admin UI, sign-in, consent) read or change. */
export interface AdminDeps {
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
  clientNames: Pick<OAuthClientNames, "nameFor">;
  audit: NotionAuditService;
  /** Usage statistics (tool calls, Notion writes). */
  usage: UsageStats;
  revocation: TokenRevocationService;
  notionEnabled: boolean;
  /** Admin actions. */
  log: LogSink;
  /** Lookup failures. */
  logError: LogSink;
}
