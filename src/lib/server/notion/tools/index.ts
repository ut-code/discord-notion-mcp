// Notion MCP tools, assembled from the read and write modules, plus the change-history tools.
import type { AnyToolDefinition } from "../../mcp/registry";
import { createReadTools } from "./read";
import type { NotionToolDeps } from "./shared";
import { createWriteTools } from "./write";

export type { NotionToolDeps };
export { createNotionChangeTools, type NotionChangeToolDeps } from "./changes";

export function createNotionTools(deps: NotionToolDeps): AnyToolDefinition[] {
  const { search, getPage, queryDatabase, getDatabase, getComments } = createReadTools(deps);
  const { createPage, appendContent, editContent, updateProperties, archivePage } = createWriteTools(deps);
  return [search, getPage, queryDatabase, getDatabase, getComments, createPage, appendContent, editContent, updateProperties, archivePage];
}
