/**
 * The longest a tool call waits out a Discord or Notion rate limit, as the official Notion MCP
 * does; a longer one fails at once so the AI is told when to retry instead of hanging.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 2000;
