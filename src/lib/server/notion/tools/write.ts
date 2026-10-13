// Write Notion tools: create_page, append_content, edit_content, update_properties, archive_page.
import { z } from "zod";
import { defineTool, type AnyToolDefinition } from "../../mcp/registry";
import { actorOf } from "../changes/attribution";
import { MAX_CONTENT_EDITS, type WriteOutcome } from "../changes/write-service";
import { requireNotionId } from "../client/ids";
import { idOrUrl, withNotionErrors, type NotionToolDeps } from "./shared";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const MAX_PROPERTY_VALUES_JSON_LENGTH = 100_000;

const propertyValues = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .refine((value) => JSON.stringify(value).length <= MAX_PROPERTY_VALUES_JSON_LENGTH, {
    message: `Property values are too large (at most ${MAX_PROPERTY_VALUES_JSON_LENGTH} characters as JSON).`,
  })
  .describe(
    'Notion property values keyed by property name, e.g. {"Status": {"status": {"name": "Done"}}, "Tags": {"multi_select": [{"name": "a"}]}, "Due": {"date": {"start": "2026-10-12"}}, "Notes": {"rich_text": [{"text": {"content": "..."}}]}}. Use notion_get_database for the schema.',
  );

const WRITE_NOTE =
  "Every write is recorded in the audit log with your Discord identity, attributed by a comment on the page, and can be reverted (notion_revert_change, or an admin).";

const NO_CHILD_OBJECTS = "Content must not contain <page>, <database> or <data-source> tags; create pages with notion_create_page.";

function outcomeLines(outcome: WriteOutcome): string[] {
  const lines: string[] = [];
  if (outcome.warning) lines.push(`Warning: ${outcome.warning}`);
  if (outcome.commentError) lines.push(`Note: the attribution comment could not be posted (${outcome.commentError}).`);
  return lines;
}

export function createWriteTools(deps: NotionToolDeps): {
  createPage: AnyToolDefinition;
  appendContent: AnyToolDefinition;
  editContent: AnyToolDefinition;
  updateProperties: AnyToolDefinition;
  archivePage: AnyToolDefinition;
} {
  const { writes } = deps;

  const createPage = defineTool({
    name: "notion_create_page",
    title: "Create a Notion page",
    description: `Create a page under a page, or a row in a database / data source, with optional content (Notion-flavored Markdown, see notion_get_page; a leading "# Heading" stays in the body, the title is set separately). ${NO_CHILD_OBJECTS} ${WRITE_NOTE}`,
    permission: "notion:write",
    inputSchema: z.object({
      parent: idOrUrl("Parent page, database or data source"),
      title: z.string().min(1).max(2000).describe("Page title"),
      properties: propertyValues.optional().describe("Only for database parents: other property values keyed by property name"),
      content: z.string().max(200_000).optional().describe("Page content as Notion-flavored Markdown"),
    }),
    annotations: WRITE,
    handler: withNotionErrors(async (args, principal) => {
      const outcome = await writes.createPage(actorOf(principal), {
        parentId: requireNotionId(args.parent, "parent"),
        title: args.title,
        properties: args.properties,
        content: args.content,
        request: args,
      });
      return [
        `Created page "${args.title}" (id ${outcome.pageId}): ${outcome.url} — audit #${outcome.auditId}`,
        ...outcomeLines(outcome),
      ].join("\n");
    }),
  });

  const appendContent = defineTool({
    name: "notion_append_content",
    title: "Append content to a Notion page",
    description: `Add content at the end (default) or the start of a page. Content is Notion-flavored Markdown (see notion_get_page). To insert in the middle of a page use notion_edit_content. ${NO_CHILD_OBJECTS} ${WRITE_NOTE}`,
    permission: "notion:write",
    inputSchema: z.object({
      page: idOrUrl("Page"),
      content: z.string().min(1).max(200_000).describe("Content to add, as Notion-flavored Markdown"),
      position: z.enum(["end", "start"]).default("end").describe("Where to add the content"),
    }),
    annotations: WRITE,
    handler: withNotionErrors(async (args, principal) => {
      const outcome = await writes.appendContent(actorOf(principal), {
        pageId: requireNotionId(args.page, "page"),
        content: args.content,
        position: args.position,
        request: args,
      });
      const where = args.position === "start" ? "the start" : "the end";
      return [`Added content at ${where} of ${outcome.url} — audit #${outcome.auditId}`, ...outcomeLines(outcome)].join("\n");
    }),
  });

  const editContent = defineTool({
    name: "notion_edit_content",
    title: "Edit Notion page content",
    description: `Edit a page's content by search and replace on its Notion-flavored Markdown. Call notion_get_page first and copy old_str exactly from the current content. Each old_str must match exactly one place: include surrounding text to make it unique. To insert new blocks in the middle, use an anchor sentence as old_str and the anchor followed by the new blocks as new_str (e.g. old_str "Anchor." → new_str "Anchor.\\n\\nNew paragraph."). To delete, set new_str to "" or to the surrounding text without the removed part. Edits are applied in order. ${NO_CHILD_OBJECTS} ${WRITE_NOTE}`,
    permission: "notion:write",
    inputSchema: z.object({
      page: idOrUrl("Page"),
      edits: z
        .array(
          z.object({
            old_str: z.string().min(1).max(200_000).describe("Exact current text to replace; must occur exactly once"),
            new_str: z.string().max(200_000).describe("Replacement text (Notion-flavored Markdown); empty to delete"),
          }),
        )
        .min(1)
        .max(MAX_CONTENT_EDITS)
        .describe(`1-${MAX_CONTENT_EDITS} replacements, applied in order`),
    }),
    annotations: WRITE,
    handler: withNotionErrors(async (args, principal) => {
      const outcome = await writes.editContent(actorOf(principal), {
        pageId: requireNotionId(args.page, "page"),
        edits: args.edits,
        request: args,
      });
      return [`Applied ${args.edits.length} edit(s) to ${outcome.url} — audit #${outcome.auditId}`, ...outcomeLines(outcome)].join("\n");
    }),
  });

  const updateProperties = defineTool({
    name: "notion_update_properties",
    title: "Update Notion page properties",
    description: `Update property values of a page (e.g. a database row). Only writable property types are accepted. ${WRITE_NOTE}`,
    permission: "notion:write",
    inputSchema: z.object({
      page: idOrUrl("Page"),
      properties: propertyValues,
    }),
    annotations: WRITE,
    handler: withNotionErrors(async (args, principal) => {
      const outcome = await writes.updateProperties(actorOf(principal), {
        pageId: requireNotionId(args.page, "page"),
        properties: args.properties,
        request: args,
      });
      return [`Updated ${outcome.changed.join(", ")} on ${outcome.url} — audit #${outcome.auditId}`, ...outcomeLines(outcome)].join("\n");
    }),
  });

  const archivePage = defineTool({
    name: "notion_archive_page",
    title: "Archive a Notion page",
    description: `Move a page to the trash (restorable by reverting the change). ${WRITE_NOTE}`,
    permission: "notion:write",
    inputSchema: z.object({ page: idOrUrl("Page") }),
    annotations: { ...WRITE, destructiveHint: true },
    handler: withNotionErrors(async (args, principal) => {
      const outcome = await writes.archivePage(actorOf(principal), { pageId: requireNotionId(args.page, "page"), request: args });
      return [`Moved ${outcome.url} to the trash — audit #${outcome.auditId}`, ...outcomeLines(outcome)].join("\n");
    }),
  });

  return { createPage, appendContent, editContent, updateProperties, archivePage };
}
