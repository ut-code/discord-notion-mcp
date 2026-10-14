import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { ToolCallErrorKind } from "../db/schema";
import { errorMessage, ToolError } from "../lib/errors";
import { logError, logEvent, type ErrorSink, type ToolCallLogEntry } from "../lib/log";
import type { EffectiveAccess } from "../permissions/resolver";
import type { RateLimitDecision } from "../lib/rate-limit";
import { toolsForPermissions, type AnyToolArgs, type AnyToolDefinition, type Principal, type ToolResult } from "./registry";

const SERVER_INFO = { name: "discord-notion-mcp", version: "0.1.0" } as const;

/** Sent as the server instructions when the caller may use no tool at all. */
export const NO_PERMISSIONS_INSTRUCTIONS =
  "This account is connected but has no permissions yet, so no tools are available. Ask an administrator of the Discord server to grant access (Discord read / Notion read / Notion write). Relay this to the user in their language.";

export interface McpServerDeps {
  tools: readonly AnyToolDefinition[];
  /** Re-resolves the caller's access right before a tool runs (defense in depth). */
  resolveAccess: (discordUserId: string) => Promise<EffectiveAccess>;
  /** Per-user tool call budget, shared across requests; every call (admins too) takes one token. */
  rateLimit?: { take(key: string): RateLimitDecision };
  /** Tool call log; defaults to stdout. */
  log?: (entry: ToolCallLogEntry) => void;
  /** Usage statistics; a failure here never fails the tool call. */
  record?: (entry: ToolCallLogEntry) => void;
  /** Unexpected tool failures; defaults to stderr. */
  logError?: ErrorSink;
}

function toCallToolResult(result: ToolResult): CallToolResult {
  return typeof result === "string" ? { content: [{ type: "text", text: result }] } : result;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Logged and stored instead of the text of an error result a tool returns (which may
 * quote content) and of an unexpected crash (whose details go to the error log only).
 */
export const TOOL_RESULT_ERROR = "tool returned an error";
export const TOOL_CRASH_ERROR = "internal error";

export async function runTool(
  tool: AnyToolDefinition,
  args: AnyToolArgs,
  principal: Principal,
  deps: McpServerDeps,
): Promise<CallToolResult> {
  const started = performance.now();
  const reportError = deps.logError ?? logError;
  const finish = (ok: boolean, failure?: { kind: ToolCallErrorKind; message: string }) => {
    const entry: ToolCallLogEntry = {
      event: "tool_call",
      discordUserId: principal.discordUserId,
      tool: tool.name,
      ok,
      durationMs: Math.round(performance.now() - started),
      ...(failure ? { errorKind: failure.kind, error: failure.message } : {}),
    };
    (deps.log ?? logEvent)(entry);
    try {
      deps.record?.(entry);
    } catch (error) {
      reportError({ event: "tool_call_record_failed", tool: tool.name, error: errorMessage(error) });
    }
  };

  try {
    const budget = deps.rateLimit?.take(principal.discordUserId);
    if (budget && !budget.ok) {
      const message = `Rate limit exceeded; retry in ${budget.retryAfterSeconds} s.`;
      finish(false, { kind: "rate_limited", message });
      return errorResult(message);
    }
    const current = await deps.resolveAccess(principal.discordUserId);
    if (!current.isMember || !current.permissions.has(tool.permission)) {
      throw new ToolError(`You do not have the "${tool.permission}" permission required for this tool.`);
    }
    const result = toCallToolResult(await tool.handler(args, { principal: { ...principal, access: current } }));
    finish(!result.isError, result.isError ? { kind: "error", message: TOOL_RESULT_ERROR } : undefined);
    return result;
  } catch (error) {
    if (error instanceof ToolError) {
      finish(false, { kind: "error", message: error.message });
      return errorResult(error.message);
    }
    reportError({ event: "tool_crash", tool: tool.name, error: errorMessage(error) });
    finish(false, { kind: "error", message: TOOL_CRASH_ERROR });
    return errorResult("Internal error while running the tool. Please try again later.");
  }
}

/** Builds a server exposing only the tools the principal may use. */
export function buildMcpServer(principal: Principal, deps: McpServerDeps): McpServer {
  const permitted = toolsForPermissions(deps.tools, principal.access.permissions);
  // Declaring `tools` up front installs the tool handlers even when none is registered,
  // so a caller without permissions gets an empty list instead of "Method not found".
  // The list is fixed per request, hence no list-changed notifications.
  const server = new McpServer(SERVER_INFO, {
    instructions: permitted.length === 0 ? NO_PERMISSIONS_INSTRUCTIONS : undefined,
    capabilities: { tools: { listChanged: false } },
  });
  for (const tool of permitted) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args) => runTool(tool, args, principal, deps),
    );
  }
  return server;
}
