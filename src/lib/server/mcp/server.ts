import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { EffectiveAccess } from "../authz/resolver";
import type { ToolCallErrorKind } from "../db/schema";
import { errorMessage, ToolError } from "../lib/errors";
import { logError, logEvent, type LogSink } from "../lib/log";
import type { RateLimitDecision } from "../lib/rate-limit";
import { toolsForPermissions, type AnyToolDefinition, type Principal, type ToolResult } from "./registry";

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
  logError?: LogSink;
}

export type ToolCallLogEntry = {
  event: "tool_call";
  discordUserId: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  errorKind?: ToolCallErrorKind;
  error?: string;
};

function toCallToolResult(result: ToolResult): CallToolResult {
  return typeof result === "string" ? { content: [{ type: "text", text: result }] } : result;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function runTool(tool: AnyToolDefinition, args: unknown, principal: Principal, deps: McpServerDeps): Promise<CallToolResult> {
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
    const result = toCallToolResult(
      await tool.handler(args as never, { principal: { ...principal, access: current } }),
    );
    finish(!result.isError, result.isError ? { kind: "error", message: resultText(result) } : undefined);
    return result;
  } catch (error) {
    if (error instanceof ToolError) {
      finish(false, { kind: "error", message: error.message });
      return errorResult(error.message);
    }
    const message = errorMessage(error);
    reportError({ event: "tool_crash", tool: tool.name, error: message });
    finish(false, { kind: "error", message });
    return errorResult("Internal error while running the tool. Please try again later.");
  }
}

function resultText(result: CallToolResult): string {
  return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

/** Builds a server exposing only the tools the principal may use. */
export function buildMcpServer(principal: Principal, deps: McpServerDeps): McpServer {
  const permitted = toolsForPermissions(deps.tools, principal.access.permissions);
  if (permitted.length === 0) {
    const server = new McpServer(SERVER_INFO, { instructions: NO_PERMISSIONS_INSTRUCTIONS });
    // McpServer only advertises `tools` once a tool is registered; answer with an empty list instead of "Method not found".
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    return server;
  }
  const server = new McpServer(SERVER_INFO);
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
