import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { EffectiveAccess } from "../authz/resolver";
import { errorMessage, ToolError } from "../lib/errors";
import { logError, logEvent, type LogSink } from "../lib/log";
import type { RateLimitDecision } from "../lib/rate-limit";
import { toolsForPermissions, type AnyToolDefinition, type Principal, type ToolResult } from "./registry";

const SERVER_INFO = { name: "discord-notion-mcp", version: "0.1.0" } as const;

export interface McpServerDeps {
  tools: readonly AnyToolDefinition[];
  /** Re-resolves the caller's access right before a tool runs (defense in depth). */
  resolveAccess: (discordUserId: string) => Promise<EffectiveAccess>;
  /** Per-user tool call budget, shared across requests; every call (admins too) takes one token. */
  rateLimit?: { take(key: string): RateLimitDecision };
  /** Tool call log; defaults to stdout. */
  log?: (entry: ToolCallLogEntry) => void;
  /** Unexpected tool failures; defaults to stderr. */
  logError?: LogSink;
}

export type ToolCallLogEntry = {
  event: "tool_call";
  discordUserId: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
};

function toCallToolResult(result: ToolResult): CallToolResult {
  return typeof result === "string" ? { content: [{ type: "text", text: result }] } : result;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function runTool(tool: AnyToolDefinition, args: unknown, principal: Principal, deps: McpServerDeps): Promise<CallToolResult> {
  const started = performance.now();
  const log = deps.log ?? logEvent;
  const finish = (ok: boolean, error?: string) =>
    log({
      event: "tool_call",
      discordUserId: principal.discordUserId,
      tool: tool.name,
      ok,
      durationMs: Math.round(performance.now() - started),
      ...(error ? { error } : {}),
    });

  try {
    const budget = deps.rateLimit?.take(principal.discordUserId);
    if (budget && !budget.ok) throw new ToolError(`Rate limit exceeded; retry in ${budget.retryAfterSeconds} s.`);
    const current = await deps.resolveAccess(principal.discordUserId);
    if (!current.isMember || !current.permissions.has(tool.permission)) {
      throw new ToolError(`You do not have the "${tool.permission}" permission required for this tool.`);
    }
    const result = toCallToolResult(
      await tool.handler(args as never, { principal: { ...principal, access: current } }),
    );
    finish(!result.isError);
    return result;
  } catch (error) {
    if (error instanceof ToolError) {
      finish(false, error.message);
      return errorResult(error.message);
    }
    const message = errorMessage(error);
    (deps.logError ?? logError)({ event: "tool_crash", tool: tool.name, error: message });
    finish(false, message);
    return errorResult("Internal error while running the tool. Please try again later.");
  }
}

/** Builds a server exposing only the tools the principal may use. */
export function buildMcpServer(principal: Principal, deps: McpServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  const permitted = toolsForPermissions(deps.tools, principal.access.permissions);
  if (permitted.length === 0) {
    // McpServer only advertises `tools` once a tool is registered; answer with an empty list instead of "Method not found".
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    return server;
  }
  for (const tool of permitted) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args: unknown) => runTool(tool, args, principal, deps),
    );
  }
  return server;
}
