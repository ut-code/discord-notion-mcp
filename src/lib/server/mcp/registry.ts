import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Permission } from "../authz/permissions";
import type { EffectiveAccess } from "../authz/resolver";

export type MemberAccess = Extract<EffectiveAccess, { isMember: true }>;

/** The authenticated caller of an MCP request. */
export interface Principal {
  userId: string;
  discordUserId: string;
  clientId: string;
  access: MemberAccess;
}

export interface ToolContext {
  principal: Principal;
}

export type ToolResult = string | CallToolResult;

/**
 * A tool exposed over MCP. Each tool declares the permission required to see
 * and call it; the server only registers tools the caller is permitted to use.
 */
export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  permission: Permission;
  inputSchema: S;
  annotations?: ToolAnnotations;
  handler(args: z.output<S>, ctx: ToolContext): Promise<ToolResult>;
}

export type AnyToolDefinition = ToolDefinition<z.ZodObject>;

/** Annotations of tools that only read from Discord or Notion. */
export const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const satisfies ToolAnnotations;

export function defineTool<S extends z.ZodObject>(definition: ToolDefinition<S>): ToolDefinition<S> {
  return definition;
}

export function toolsForPermissions(
  tools: readonly AnyToolDefinition[],
  permissions: ReadonlySet<Permission>,
): AnyToolDefinition[] {
  return tools.filter((tool) => permissions.has(tool.permission));
}
