// Read-only Notion tools: search, get_page, query_database, get_database, get_comments.
import { z } from "zod";
import { defineTool, READ_ONLY_ANNOTATIONS, type AnyToolDefinition } from "../../mcp/registry";
import type { NotionDataSource, NotionPage, SearchResult } from "../client/api";
import { requireNotionId } from "../client/ids";
import { dataSourceTitle, resolveDatabaseView, resolveDataSource } from "../client/resolve";
import { labelUserMentions } from "../content/enhanced-markdown";
import { pageTitle, renderPropertyValue, WRITABLE_PROPERTY_TYPES } from "../content/properties";
import { plainText } from "../content/rich-text";
import { idOrUrl, withNotionErrors, type NotionToolDeps } from "./shared";

const MARKDOWN_SYNTAX =
  'Content uses Notion-flavored Markdown: standard Markdown plus user mentions <mention-user url="user://USER_ID">Name</mention-user>, page mentions <mention-page url="PAGE_URL"/>, dates <mention-date start="2026-10-20"/>, toggles <details><summary>Title</summary> followed by tab-indented children and </details>, callouts <callout icon="💡">text</callout>, inline colors <span color="red">text</span> (block colors: {color="blue_bg"} at the end of a block line), and columns <columns><column>…</column></columns>.';

function parentLabel(parent: SearchResult["parent"]): string {
  switch (parent.type) {
    case "page_id":
      return `page ${parent.page_id}`;
    case "database_id":
      return `database ${parent.database_id}`;
    case "data_source_id":
      return `data source ${parent.data_source_id}`;
    case "block_id":
      return `block ${parent.block_id}`;
    case "workspace":
      return "workspace";
    default:
      return parent.type ?? "unknown";
  }
}

function describeSearchResult(item: SearchResult): string {
  if (item.object === "page") {
    return `- [page] ${pageTitle(item)} (id ${item.id})\n  url: ${item.url} | edited: ${item.last_edited_time} | parent: ${parentLabel(item.parent)}`;
  }
  return `- [data source] ${dataSourceTitle(item)} (id ${item.id})\n  url: ${item.url} | edited: ${item.last_edited_time} | parent: ${parentLabel(item.parent)}`;
}

function propertyLines(page: NotionPage, options: { skipTitle: boolean; skipEmpty: boolean; indent: string }): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(page.properties)) {
    if (options.skipTitle && value.type === "title") continue;
    const text = renderPropertyValue(value).replace(/\s*\n\s*/g, " ");
    if (options.skipEmpty && !text) continue;
    lines.push(`${options.indent}- ${name} (${value.type}): ${text}`);
  }
  return lines;
}

function schemaLines(dataSource: NotionDataSource): string[] {
  return Object.entries(dataSource.properties).map(([name, c]) => {
    const details: string[] = [];
    if (c.type === "select" || c.type === "multi_select" || c.type === "status") {
      const { options } = c.type === "select" ? c.select : c.type === "multi_select" ? c.multi_select : c.status;
      details.push(`options: ${options.length ? options.map((o) => o.name).join(", ") : "(none)"}`);
    }
    if (c.type === "status") {
      const byId = new Map(c.status.options.map((o) => [o.id, o.name]));
      const groups = c.status.groups.map((g) => `${g.name} [${g.option_ids.map((id) => byId.get(id) ?? id).join(", ")}]`);
      details.push(`groups: ${groups.join("; ")}`);
    }
    if (c.type === "relation") details.push(`related data source: ${c.relation.data_source_id}`);
    if (c.type === "number" && c.number?.format) details.push(`format: ${c.number.format}`);
    if (c.type === "formula" && c.formula?.expression) details.push(`expression: ${c.formula.expression}`);
    if (c.type === "rollup")
      details.push(`rollup: ${c.rollup.function} of ${c.rollup.rollup_property_name} via ${c.rollup.relation_property_name}`);
    if (!WRITABLE_PROPERTY_TYPES.has(c.type)) details.push("read-only");
    return `- ${name} (${c.type}, id ${c.id})${details.length ? `: ${details.join(" | ")}` : ""}`;
  });
}

export function createReadTools(deps: NotionToolDeps): {
  search: AnyToolDefinition;
  getPage: AnyToolDefinition;
  queryDatabase: AnyToolDefinition;
  getDatabase: AnyToolDefinition;
  getComments: AnyToolDefinition;
} {
  const { api } = deps;

  const search = defineTool({
    name: "notion_search",
    title: "Search Notion",
    description:
      "Search pages and databases (data sources) shared with the Notion integration by title. Returns title, type, id, url, last edited time and parent.",
    permission: "notion:read",
    inputSchema: z.object({
      query: z.string().default("").describe("Text to search for in titles (empty lists recent items)"),
      filter: z.enum(["page", "data_source", "database"]).optional().describe("Only pages, or only databases/data sources"),
      limit: z.number().int().min(1).max(50).default(20).describe("Max results (1-50)"),
      start_cursor: z.string().optional().describe("Cursor from a previous call to get the next page"),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withNotionErrors(async (args) => {
      const filter = args.filter === "database" ? "data_source" : args.filter;
      const page = await api.search({ query: args.query, filter, pageSize: args.limit, startCursor: args.start_cursor });
      if (page.results.length === 0) return "No results. Only pages shared with the Notion integration are searchable.";
      const lines = [`${page.results.length} result(s):`, ...page.results.map(describeSearchResult)];
      if (page.nextCursor) lines.push("", `More results: start_cursor="${page.nextCursor}"`);
      return lines.join("\n");
    }),
  });

  const getPage = defineTool({
    name: "notion_get_page",
    title: "Get a Notion page",
    description: `Get a page's properties and its full content. ${MARKDOWN_SYNTAX} Child pages and databases appear as <page>/<database> tags. Use the content as the source of old_str for notion_edit_content.`,
    permission: "notion:read",
    inputSchema: z.object({ page: idOrUrl("Page") }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withNotionErrors(async (args) => {
      const pageId = requireNotionId(args.page, "page");
      const page = await api.retrievePage(pageId);
      const body = await api.retrievePageMarkdown(page.id);
      const names = new Map<string, Promise<string | null>>();
      const lookup = (userId: string) => {
        let name = names.get(userId);
        if (!name) {
          name = api.retrieveUser(userId);
          names.set(userId, name);
        }
        return name;
      };
      const content = await labelUserMentions(body.markdown, lookup);
      const lines = [
        `# ${pageTitle(page)}`,
        `id: ${page.id} | url: ${page.url} | last edited: ${page.last_edited_time} | parent: ${parentLabel(page.parent)}`,
      ];
      if (page.in_trash) lines.push("(This page is in the trash.)");
      lines.push("", "## Properties", ...propertyLines(page, { skipTitle: false, skipEmpty: false, indent: "" }));
      lines.push("", "## Content", content.trim() ? content : "(empty)");
      if (body.truncated) {
        const unknown = body.unknownBlockIds.length > 0 ? ` Blocks not included: ${body.unknownBlockIds.join(", ")}.` : "";
        lines.push("", `(The content was truncated by Notion because the page is too large.${unknown})`);
      }
      return lines.join("\n");
    }),
  });

  const queryDatabase = defineTool({
    name: "notion_query_database",
    title: "Query a Notion database",
    description:
      "Query rows of a database or data source with optional Notion filter/sorts JSON. A database with several data sources requires picking a data source id.",
    permission: "notion:read",
    inputSchema: z.object({
      database: idOrUrl("Database or data source"),
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Notion filter object, e.g. {"property": "Status", "status": {"equals": "Done"}}'),
      sorts: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('Notion sorts array, e.g. [{"property": "Due", "direction": "ascending"}]'),
      limit: z.number().int().min(1).max(100).default(25).describe("Max rows (1-100)"),
      start_cursor: z.string().optional().describe("Cursor from a previous call to get the next page"),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withNotionErrors(async (args) => {
      const { dataSource } = await resolveDataSource(api, requireNotionId(args.database, "database"));
      const page = await api.queryDataSource({
        dataSourceId: dataSource.id,
        filter: args.filter,
        sorts: args.sorts,
        pageSize: args.limit,
        startCursor: args.start_cursor,
      });
      const header = `Data source "${dataSourceTitle(dataSource)}" (id ${dataSource.id}) — ${page.results.length} row(s)`;
      if (page.results.length === 0) return `${header}\n\nNo rows match.`;
      const rows = page.results.map((row) =>
        [
          `- ${pageTitle(row)} (id ${row.id})`,
          `  url: ${row.url}`,
          ...propertyLines(row, { skipTitle: true, skipEmpty: true, indent: "  " }),
        ].join("\n"),
      );
      const lines = [header, "", ...rows];
      if (page.nextCursor) lines.push("", `More rows: start_cursor="${page.nextCursor}"`);
      return lines.join("\n");
    }),
  });

  const getDatabase = defineTool({
    name: "notion_get_database",
    title: "Get a Notion database schema",
    description:
      "Get a database's data sources and their schema (property names, types, select/status options). Use it before creating rows or updating properties.",
    permission: "notion:read",
    inputSchema: z.object({ database: idOrUrl("Database or data source") }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withNotionErrors(async (args) => {
      const view = await resolveDatabaseView(api, requireNotionId(args.database, "database"));
      const lines: string[] = [];
      if (view.database) {
        lines.push(
          `Database "${plainText(view.database.title) || "Untitled"}" (id ${view.database.id})`,
          `url: ${view.database.url}`,
          `Data sources (${view.dataSources.length}):`,
        );
      }
      for (const dataSource of view.dataSources) {
        lines.push(
          "",
          `## Data source "${dataSourceTitle(dataSource)}" (id ${dataSource.id})`,
          `parent: ${parentLabel(dataSource.parent)}`,
          "Properties:",
          ...schemaLines(dataSource),
        );
      }
      return lines.join("\n").trim();
    }),
  });

  const getComments = defineTool({
    name: "notion_get_comments",
    title: "Get Notion comments",
    description: "List the unresolved comments on a page or block (author type, time, text).",
    permission: "notion:read",
    inputSchema: z.object({ target: idOrUrl("Page or block") }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withNotionErrors(async (args) => {
      const blockId = requireNotionId(args.target, "target", { allowBlockAnchor: true });
      const comments = [];
      let cursor: string | undefined;
      let more = false;
      for (let page = 0; page < 3; page++) {
        const result = await api.listComments(blockId, { startCursor: cursor, pageSize: 100 });
        comments.push(...result.results);
        cursor = result.nextCursor ?? undefined;
        more = cursor !== undefined;
        if (!more) break;
      }
      if (comments.length === 0) return "No comments.";
      const lines = comments.map((comment) => {
        const author = comment.display_name?.resolved_name ?? comment.created_by.id;
        const kind = comment.display_name?.type ?? "user";
        return `- [${comment.created_time}] ${author} (${kind}): ${plainText(comment.rich_text)}`;
      });
      if (more) lines.push("(More comments exist; only the first 300 are shown.)");
      return [`${comments.length} comment(s):`, ...lines].join("\n");
    }),
  });

  return { search, getPage, queryDatabase, getDatabase, getComments };
}
