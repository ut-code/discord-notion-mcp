// Discord MCP tools, assembled from per-area modules.
import type { AnyToolDefinition } from "../../mcp/registry";
import { createChannelTools } from "./channels";
import { createEventTools } from "./events";
import { createMemberTools } from "./members";
import { createMessageTools } from "./messages";
import { createSearchTools } from "./search";
import type { DiscordToolDeps } from "./shared";

export type { DiscordToolDeps };

export function createDiscordTools(deps: DiscordToolDeps): AnyToolDefinition[] {
  const { listChannels, listThreads } = createChannelTools(deps);
  const { readMessages, getMessage, listPins } = createMessageTools(deps);
  const { searchMessages } = createSearchTools(deps);
  const { findMember } = createMemberTools(deps);
  const { listEvents } = createEventTools(deps);
  return [listChannels, listThreads, readMessages, getMessage, searchMessages, findMember, listPins, listEvents];
}
