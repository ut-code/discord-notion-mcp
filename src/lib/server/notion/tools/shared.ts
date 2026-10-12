// Shared types and helpers used by the Notion read and write tool modules.
import { z } from "zod";
import type { NotionApi } from "../client/api";
import { toToolError } from "../client/resolve";
import type { Principal, ToolResult } from "../../mcp/registry";
import type { NotionWriteService } from "../changes/write-service";

export interface NotionToolDeps {
  api: NotionApi;
  writes: NotionWriteService;
}

export const idOrUrl = (what: string) => z.string().min(1).describe(`${what} (Notion URL or id, with or without dashes)`);

export function withNotionErrors<A>(handler: (args: A, principal: Principal) => Promise<ToolResult>) {
  return async (args: A, ctx: { principal: Principal }): Promise<ToolResult> => {
    try {
      return await handler(args, ctx.principal);
    } catch (error) {
      throw toToolError(error);
    }
  };
}
