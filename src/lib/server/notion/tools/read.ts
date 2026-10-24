// Read-only Notion tools: search, get_page, get_users, query_database, get_database, get_comments.
import { z } from "zod";
import { defineTool, READ_ONLY_ANNOTATIONS, type AnyToolDefinition } from "../../mcp/registry";
import {
  isNotionMiss,
  notionFailure,
  NotionRequestError,
  type NotionComment,
  type NotionDataSource,
  type NotionPage,
  type NotionUser,
  type PageMarkdown,
  type SearchResult,
} from "../client/api";
import { ToolError } from "../../lib/errors";
import { parseBareNotionId, requireNotionId } from "../client/ids";
import { dataSourceTitle, resolveDatabaseView, resolveDataSource } from "../client/resolve";
import { pageTitle, renderPropertyValue, WRITABLE_PROPERTY_TYPES } from "../content/properties";
import { plainText } from "../content/rich-text";
import { idOrUrl, withNotionErrors, type NotionToolDeps } from "./shared";

const MARKDOWN_SYNTAX =
  'Content uses Notion-flavored Markdown: standard Markdown plus user mentions <mention-user url="user://USER_ID"/>, page mentions <mention-page url="PAGE_URL"/>, dates <mention-date start="2026-10-20"/>, toggles <details><summary>Title</summary> followed by tab-indented children and </details>, callouts <callout icon="💡">text</callout>, inline colors <span color="red">text</span> (block colors: {color="blue_bg"} at the end of a block line), and columns <columns><column>…</column></columns>.';

/** Users looked up per call at most, one Notion request each. */
const MAX_USERS = 20;

const COMMENT_PAGE_SIZE = 100;
/** Comments listed per call at most, in pages of COMMENT_PAGE_SIZE. */
const MAX_COMMENTS = 300;
/**
 * Blocks whose comments one call lists at most. Each takes a request of its own, one after another,
 * and Notion allows about three requests a second, so this keeps a call within several seconds.
 */
const MAX_COMMENTED_BLOCKS = 20;
/** Notion's markdown marks commented text and blocks with `discussion://<page>/<block>/<discussion>` URLs. */
const DISCUSSION_URL = /discussion:\/\/[^/",\s]+\/([0-9a-f-]+)\//gi;
/** Inline comments wrap the commented text: `<span discussion-urls="…">text</span>` (other attributes may come along). */
const COMMENTED_SPAN = /<span [^>]*?discussion-urls="([^"]*)"[^>]*>([^<]*)<\/span>/g;
/** Longest commented text quoted next to a block id. */
const MAX_QUOTE = 40;

/** Blocks with comments, in page order, with the first text commented on in each (when inline). */
function commentedBlocks(markdown: string): Array<{ id: string; text: string | null }> {
  // Ids in the dashed lowercase form of requireNotionId, so the page's own id is recognized.
  const blockIds = (text: string) => [...text.matchAll(DISCUSSION_URL)].flatMap(([, id = ""]) => parseBareNotionId(id) ?? []);
  const quotes = new Map<string, string>();
  for (const [, urls = "", text = ""] of markdown.matchAll(COMMENTED_SPAN)) {
    // By code point, so an emoji is never cut in half.
    const chars = [...text.trim()];
    const quote = chars.length > MAX_QUOTE ? `${chars.slice(0, MAX_QUOTE).join("")}…` : chars.join("");
    for (const id of blockIds(urls)) {
      if (quote && !quotes.has(id)) quotes.set(id, quote);
    }
  }
  return [...new Set(blockIds(markdown))].map((id) => ({ id, text: quotes.get(id) ?? null }));
}

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
    // One line per property. /\s+/ stays linear; /\s*\n\s*/ took seconds on a long run of spaces.
    const text = renderPropertyValue(value).replace(/\s+/g, " ");
    if (options.skipEmpty && !text) continue;
    lines.push(`${options.indent}- ${name} (${value.type}): ${text}`);
  }
  return lines;
}

function describeUser(user: NotionUser): string {
  return `- user://${user.id}: ${user.name?.replace(/\s+/g, " ") ?? "(no name)"} (${user.type})`;
}

function schemaLines(dataSource: NotionDataSource): string[] {
  return Object.entries(dataSource.properties).map(([name, property]) => {
    const details: string[] = [];
    if (property.type === "select" || property.type === "multi_select" || property.type === "status") {
      const { options } =
        property.type === "select" ? property.select : property.type === "multi_select" ? property.multi_select : property.status;
      details.push(`options: ${options.length ? options.map((option) => option.name).join(", ") : "(none)"}`);
    }
    if (property.type === "status") {
      const optionNames = new Map(property.status.options.map((option) => [option.id, option.name]));
      const groups = property.status.groups.map(
        (group) => `${group.name} [${group.option_ids.map((id) => optionNames.get(id) ?? id).join(", ")}]`,
      );
      details.push(`groups: ${groups.join("; ")}`);
    }
    if (property.type === "relation") details.push(`related data source: ${property.relation.data_source_id}`);
    if (property.type === "number" && property.number?.format) details.push(`format: ${property.number.format}`);
    if (property.type === "formula" && property.formula?.expression) details.push(`expression: ${property.formula.expression}`);
    if (property.type === "rollup") {
      const { rollup } = property;
      details.push(`rollup: ${rollup.function} of ${rollup.rollup_property_name} via ${rollup.relation_property_name}`);
    }
    if (!WRITABLE_PROPERTY_TYPES.has(property.type)) details.push("read-only");
    return `- ${name} (${property.type}, id ${property.id})${details.length ? `: ${details.join(" | ")}` : ""}`;
  });
}

export function createReadTools(deps: NotionToolDeps): {
  search: AnyToolDefinition;
  getPage: AnyToolDefinition;
  getUsers: AnyToolDefinition;
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
      // Since API version 2025-09-03 tables are data sources inside databases; search filters by data source.
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
    description: `Get a page's properties and its full content. ${MARKDOWN_SYNTAX} Child pages and databases appear as <page>/<database> tags. Look up mentioned users with notion_get_users. Use the content as the source of old_str for notion_edit_content.`,
    permission: "notion:read",
    inputSchema: z.object({ page: idOrUrl("Page") }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withNotionErrors(async (args) => {
      const pageId = requireNotionId(args.page, "page");
      const page = await api.retrievePage(pageId);
      const body = await api.retrievePageMarkdown(page.id);
      const lines = [
        `# ${pageTitle(page)}`,
        `id: ${page.id} | url: ${page.url} | last edited: ${page.last_edited_time} | parent: ${parentLabel(page.parent)}`,
      ];
      if (page.in_trash) lines.push("(This page is in the trash.)");
      lines.push("", "## Properties", ...propertyLines(page, { skipTitle: false, skipEmpty: false, indent: "" }));
      lines.push("", "## Content", body.markdown.trim() ? body.markdown : "(empty)");
      if (body.truncated) {
        const unknown = body.unknownBlockIds.length > 0 ? ` Blocks not included: ${body.unknownBlockIds.join(", ")}.` : "";
        lines.push("", `(The content was truncated by Notion because the page is too large.${unknown})`);
      }
      return lines.join("\n");
    }),
  });

  const getUsers = defineTool({
    name: "notion_get_users",
    title: "Get Notion users",
    description: `Look up workspace members, guests and bots by user id, e.g. from <mention-user url="user://USER_ID"/>. Returns each user's name and type (person or bot). Up to ${MAX_USERS} users per call. Users cannot be searched by name.`,
    permission: "notion:read",
    inputSchema: z.object({
      user_ids: z.array(z.string()).min(1).max(MAX_USERS).describe('User ids, bare or as "user://USER_ID"'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withNotionErrors(async (args) => {
      const ids = [
        ...new Set(
          args.user_ids.map((input, index) => {
            const id = parseBareNotionId(input.replace(/^user:\/\//, ""));
            if (!id) throw new ToolError(`Invalid "user_ids[${index}]": expected a user id (32 hex characters, with or without dashes).`);
            return id;
          }),
        ),
      ];
      const lines = await Promise.all(
        ids.map((id) =>
          api.retrieveUser(id).then(describeUser, (error: unknown) => {
            if (isNotionMiss(error)) return `- user://${id}: not found or not accessible`;
            if (error instanceof NotionRequestError) return `- user://${id}: lookup failed (${notionFailure(error)}); retry later`;
            throw error;
          }),
        ),
      );
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

  /** The templates for notion_create_page's template_id; a Notion refusal leaves them out rather than failing the schema. */
  const templateLines = async (dataSourceId: string): Promise<string[]> => {
    let listed: Awaited<ReturnType<typeof api.listTemplates>>;
    try {
      listed = await api.listTemplates(dataSourceId);
    } catch (error) {
      if (error instanceof NotionRequestError) return ["Templates: (could not be listed)"];
      throw error;
    }
    if (listed.templates.length === 0) return [];
    return [
      "Templates (template_id of notion_create_page):",
      ...listed.templates.map(
        (template) => `- ${template.name || "Untitled"} (id ${template.id})${template.isDefault ? " — default" : ""}`,
      ),
      ...(listed.more ? ["- (more templates exist; only the first 100 are listed)"] : []),
    ];
  };

  const getDatabase = defineTool({
    name: "notion_get_database",
    title: "Get a Notion database schema",
    description:
      "Get a database's data sources, their schema (property names, types, select/status options) and their templates. Use it before creating rows or updating properties.",
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
      const templates = await Promise.all(view.dataSources.map((dataSource) => templateLines(dataSource.id)));
      view.dataSources.forEach((dataSource, index) => {
        lines.push(
          "",
          `## Data source "${dataSourceTitle(dataSource)}" (id ${dataSource.id})`,
          `parent: ${parentLabel(dataSource.parent)}`,
          "Properties:",
          ...schemaLines(dataSource),
          ...(templates[index] ?? []),
        );
      });
      return lines.join("\n").trim();
    }),
  });

  /** Up to `budget` comments of one page or block, and whether more exist. */
  async function listComments(blockId: string, budget: number): Promise<{ comments: NotionComment[]; more: boolean }> {
    const comments: NotionComment[] = [];
    let cursor: string | undefined;
    while (comments.length < budget) {
      const result = await api.listComments(blockId, {
        startCursor: cursor,
        pageSize: Math.min(COMMENT_PAGE_SIZE, budget - comments.length),
      });
      comments.push(...result.results);
      cursor = result.nextCursor ?? undefined;
      if (cursor === undefined) return { comments, more: false };
    }
    return { comments, more: true };
  }

  const commentLine = (comment: NotionComment) => {
    const author = comment.display_name?.resolved_name ?? comment.created_by.id;
    const kind = comment.display_name?.type ?? "user";
    return `- [${comment.created_time}] ${author} (${kind}): ${plainText(comment.rich_text)}`;
  };

  const getComments = defineTool({
    name: "notion_get_comments",
    title: "Get Notion comments",
    description:
      "List the unresolved comments on a page or block (author type, time, text). Comments on the page's text and blocks (inline comments) are left out unless include_all_blocks is set.",
    permission: "notion:read",
    inputSchema: z.object({
      target: idOrUrl("Page or block"),
      include_all_blocks: z
        .boolean()
        .default(false)
        .describe(
          `Also list the comments on the page's blocks, such as inline comments on its text (target must be a page; one more request per commented block, up to ${MAX_COMMENTED_BLOCKS} blocks)`,
        ),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: withNotionErrors(async (args) => {
      const blockId = requireNotionId(args.target, "target", { allowBlockAnchor: true });
      const own = await listComments(blockId, MAX_COMMENTS);
      if (!args.include_all_blocks) {
        if (own.comments.length === 0) return "No comments.";
        const lines = own.comments.map(commentLine);
        if (own.more) lines.push(`(More comments exist; only the first ${own.comments.length} are shown.)`);
        return [`${own.comments.length} comment(s):`, ...lines].join("\n");
      }

      let page: PageMarkdown;
      try {
        page = await api.retrievePageMarkdown(blockId);
      } catch (error) {
        if (isNotionMiss(error)) {
          throw new ToolError(
            "include_all_blocks needs a page whose content the integration can read; this target's content could not be read.",
          );
        }
        throw error;
      }
      const sections: Array<{ heading: string; comments: NotionComment[] }> = [{ heading: "On the page:", comments: own.comments }];
      let total = own.comments.length;
      let more = own.more;
      let asked = 0;
      let unreadable = 0;
      const blocks = commentedBlocks(page.markdown).filter((block) => block.id !== blockId);
      for (const block of blocks.slice(0, MAX_COMMENTED_BLOCKS)) {
        if (total >= MAX_COMMENTS) break;
        asked++;
        let listed: { comments: NotionComment[]; more: boolean };
        try {
          listed = await listComments(block.id, MAX_COMMENTS - total);
        } catch (error) {
          // One block out of reach (e.g. synced from a page the integration cannot see) does not hide the rest.
          if (!isNotionMiss(error)) throw error;
          unreadable++;
          continue;
        }
        total += listed.comments.length;
        more ||= listed.more;
        if (listed.comments.length === 0) continue;
        sections.push({
          heading: `On block ${block.id}${block.text ? ` (${JSON.stringify(block.text)})` : ""}:`,
          comments: listed.comments,
        });
      }
      const lines = total === 0 ? ["No comments."] : [`${total} comment(s):`];
      for (const section of sections) {
        if (section.comments.length > 0) lines.push(section.heading, ...section.comments.map(commentLine));
      }
      if (more) lines.push(`(More comments exist; only the first ${total} are shown.)`);
      if (blocks.length > asked) lines.push(`(Comments on ${blocks.length - asked} more commented blocks are not listed.)`);
      if (unreadable > 0) lines.push(`(${unreadable} commented blocks could not be read.)`);
      if (page.truncated) lines.push("(The page is too long to read whole: comments further down are not listed.)");
      return lines.join("\n");
    }),
  });

  return { search, getPage, getUsers, queryDatabase, getDatabase, getComments };
}
