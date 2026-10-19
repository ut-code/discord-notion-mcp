import { z } from "zod";
import type { Permission } from "../permissions/permissions";
import type { AnyToolDefinition } from "./registry";

/** A tool as MCP clients receive it in tools/list, with the permission that exposes it. */
export interface ToolListing {
  name: string;
  title: string;
  /** Written for the AI; shown to people verbatim so they read what the AI reads. */
  description: string;
  inputSchema: Record<string, unknown>;
  permission: Permission;
}

/**
 * The listing of `tool`, its input schema converted as the MCP SDK does for tools/list
 * (zod's input-side JSON Schema, draft 2020-12). The e2e tests compare the two.
 */
export function toolListing(tool: AnyToolDefinition): ToolListing {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, { target: "draft-2020-12", io: "input" }),
    permission: tool.permission,
  };
}
