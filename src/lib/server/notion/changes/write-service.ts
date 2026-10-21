import { errorMessage, ToolError } from "../../lib/errors";
import { logError, type ErrorSink } from "../../lib/log";
import {
  NO_MATCH_WARNING,
  notionFailure,
  writeMayHaveApplied,
  type EditedPageMarkdown,
  type NotionApi,
  type NotionPage,
  type PageMarkdown,
} from "../client/api";
import { resolveParent, toToolError } from "../client/resolve";
import { requireNotionId } from "../client/ids";
import type { ContentUpdate, PageMarkdownUpdate, PageParent, PageTemplate } from "../client/types";
import { JST_TIME_ZONE } from "../../lib/jst-day";
import { sha256, writeBlocker } from "../content/content-diff";
import { assertNoChildObjects, countChildObjects } from "../content/enhanced-markdown";
import {
  mayBeTruncated,
  pageTitle,
  titlePropertyName,
  toWritablePropertyValue,
  valueFromPropertyItems,
  WRITABLE_PROPERTY_TYPES,
} from "../content/properties";
import { literalRichText } from "../content/rich-text";
import { postComment, retractComment, writeComment, type Actor, type WriteOperation } from "./attribution";
import { propertyWriteRefusalText } from "./outcome-text";
import {
  ArchivePageResultSchema,
  ArchivePageSnapshotSchema,
  ContentSnapshotSchema,
  ContentWriteResultSchema,
  CreatePageResultSchema,
  CreatePageSnapshotSchema,
  ContentBeforeSnapshotSchema,
  toAuditJson,
  UpdatePropertiesResultSchema,
  UpdatePropertiesSnapshotSchema,
  type ContentSnapshot,
  type ContentWriteResult,
  type WriteWarning,
  type PropertySnapshotEntry,
} from "./audit-records";
import type { NotionAuditRow } from "../../db/schema";
import type { AuditContent, NotionAuditStore } from "./audit-store";

export type PropertyValues = Record<string, Record<string, unknown>>;

export interface WriteOutcome {
  auditId: number;
  pageId: string;
  url: string;
  commentError: string | null;
  /** Set when the write was only partially applied or cannot be reverted automatically (still recorded). */
  warning: WriteWarning | null;
}

export type ContentWriteOutcome = WriteOutcome & ContentWriteResult;

interface AuditBase {
  operation: WriteOperation;
  request: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  targetPageId: string | null;
  targetUrl: string | null;
  targetTitle: string;
}

export const MAX_CONTENT_EDITS = 20;

/**
 * Largest request a revert may send to put a page's content back: Notion takes request bodies
 * of up to 500 KB (https://developers.notion.com/reference/request-limits), less some headroom.
 */
const MAX_RESTORE_BYTES = 450_000;

/**
 * Notion fills in a template after creating the page (4–5 s when checked live). Its body is
 * awaited, within bounds, before the write is recorded, so the recorded edit time includes it and
 * a later revert does not take the template for someone's edit. Two reads in a row must agree, so
 * the body has to show by the next to last check.
 */
const TEMPLATE_CHECKS = 10;
const TEMPLATE_CHECK_INTERVAL_MS = 1_000;

/**
 * A created page Notion returned truncated: a revert reads the whole page first (child pages must
 * not go to the trash with it), so one too large to read may not be revertible.
 */
const TRUNCATED_AFTER_CREATE: WriteWarning = { kind: "revert_blocked", blocker: "truncated_after_write" };

/** A property id as Notion URL-encodes it (e.g. `%3AAbc`), decoded; an id that is not valid escaping stays as it is. */
function decodedPropertyId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/** The size of `markdown` as the replace_content request carries it (JSON-escaped). */
const restoreBytes = (markdown: string) => Buffer.byteLength(JSON.stringify(markdown));

const EDIT_HINT =
  "Call notion_get_page and copy old_str exactly from the current content; include more surrounding text when it matches several places.";

/** A Notion error as the tool error to throw, naming the audit row that recorded the failed write. */
function namingAuditRow(error: unknown, auditId: number, hint?: string): unknown {
  const mapped = toToolError(error);
  if (!(mapped instanceof ToolError)) return error;
  const suffix = ` (audit #${auditId})${hint ? ` ${hint}` : ""}`;
  return new ToolError(`${mapped.message}${suffix}`, { logMessage: `${mapped.logMessage}${suffix}` });
}

const CHECK_PAGE = "Read the page with notion_get_page";

/**
 * The tool error for a write Notion did not confirm. Retrying blindly could apply it twice,
 * so the caller is told to check first. `check` may quote page text and stays out of logs.
 */
function unconfirmedWrite(error: unknown, auditId: number, check: string): ToolError {
  const message = `Notion did not confirm the change (${notionFailure(error)}), so it may or may not have been applied (audit #${auditId}).`;
  return new ToolError(`${message} ${check} before retrying, or a retry may apply it twice.`, { logMessage: message });
}

/**
 * Executes the allowed Notion writes. Each write is recorded as pending with what is needed
 * to revert it, executes, ends its audit row and comments on the affected page to attribute
 * the change to the Discord user. Comment failures never fail a write.
 */
export class NotionWriteService {
  constructor(
    private readonly api: NotionApi,
    private readonly audit: NotionAuditStore,
    private readonly reportError: ErrorSink = logError,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Whether a template has a body to wait for; one that cannot be read is assumed to have one. */
  private async templateHasBody(templateId: string): Promise<boolean> {
    const body = await this.api.retrievePageMarkdown(templateId).catch(() => null);
    return body === null || body.markdown.trim() !== "";
  }

  /**
   * The body of a page made from a template once Notion has filled it in, null when it has not in
   * time. Notion signals no end, so the body counts as filled in once two reads in a row agree.
   */
  private async awaitTemplate(pageId: string): Promise<PageMarkdown | null> {
    let previous: string | null = null;
    for (let check = 0; check < TEMPLATE_CHECKS; check++) {
      await this.sleep(TEMPLATE_CHECK_INTERVAL_MS);
      const body = await this.api.retrievePageMarkdown(pageId).catch(() => null);
      const markdown = body?.markdown.trim() ? body.markdown : null;
      if (body && markdown !== null && markdown === previous) return body;
      previous = markdown;
    }
    return null;
  }

  /** Notion takes any page as a template (checked live), so the id must be one of the database's. */
  private async assertTemplateOf(dataSourceId: string, templateId: string): Promise<void> {
    const { templates, more } = await this.api.listTemplates(dataSourceId);
    if (templates.some((template) => template.id === templateId)) return;
    const listed = more ? "the first 100 templates" : "the templates";
    throw new ToolError(`"template_id" is not one of ${listed} of this database: pick one from notion_get_database.`);
  }

  private actorColumns(actor: Actor) {
    return {
      discordUserId: actor.discordUserId,
      discordDisplayName: actor.displayName,
      discordUsername: actor.username,
    };
  }

  /** Records the write as pending before Notion is touched: a crash leaves an interrupted row, never an unrecorded write. */
  private begin(actor: Actor, base: AuditBase): Promise<NotionAuditRow> {
    return this.audit.insert({ ...this.actorColumns(actor), ...base, status: "pending" });
  }

  /**
   * Ends a write that threw and rethrows naming the audit row: failed when Notion refused it,
   * interrupted when it may have been applied. `check` tells the caller how to find out.
   */
  private async fail(row: NotionAuditRow, error: unknown, check: string, hint?: string): Promise<never> {
    if (writeMayHaveApplied(error)) {
      await this.audit.finishPending(row.id, { status: "interrupted", error: errorMessage(error) });
      throw unconfirmedWrite(error, row.id, check);
    }
    await this.audit.finishPending(row.id, { status: "failed", error: errorMessage(error) });
    throw namingAuditRow(error, row.id, hint);
  }

  /**
   * Ends a successful write: comments on the page, then records its last_edited_time after
   * all our changes. `fallbackLastEdited` is kept when the page cannot be read back; null
   * when no trustworthy value is known.
   */
  private async succeed(
    actor: Actor,
    row: NotionAuditRow,
    operation: WriteOperation,
    page: { id: string; url: string },
    outcome: {
      result: Record<string, unknown>;
      snapshot?: Record<string, unknown>;
      warning: WriteWarning | null;
      fallbackLastEdited: string | null;
      /** The page content around a content write, or the content of a created page (before is ""). */
      content?: AuditContent;
    },
  ): Promise<WriteOutcome> {
    const { commentError } = await postComment(this.api, page.id, writeComment(actor, operation, row.id));
    // The write succeeded: a failed read-back only loses the final URL and edit time, so log it and go on.
    const final = await this.api.retrievePage(page.id).catch((error: unknown) => {
      this.reportError({ event: "notion_readback_failed", pageId: page.id, error: errorMessage(error) });
      return null;
    });
    const url = final?.url ?? page.url;
    await this.audit.finishPending(
      row.id,
      {
        status: "ok",
        result: outcome.result,
        ...(outcome.snapshot ? { snapshot: outcome.snapshot } : {}),
        note: outcome.warning,
        commentError,
        resultLastEditedTime: final?.last_edited_time ?? outcome.fallbackLastEdited,
        targetPageId: page.id,
        targetUrl: url,
      },
      outcome.content,
    );
    return { auditId: row.id, pageId: page.id, url, commentError, warning: outcome.warning };
  }

  /**
   * Creates the page from properties only, then inserts the content at its end: a leading
   * "# H1" in markdown passed to page creation would be consumed as the title. A database row
   * can come from a template instead, which Notion fills in. The new page's content is kept
   * to show what was created.
   */
  async createPage(
    actor: Actor,
    input: {
      parentId: string;
      title: string;
      properties?: PropertyValues;
      content?: string;
      /** A template of the database to fill the row from (its @today / @now in Japan time). */
      templateId?: string;
      request: Record<string, unknown>;
    },
  ): Promise<WriteOutcome> {
    const content = input.content?.trim() ? input.content : null;
    if (content) assertNoChildObjects(content, "content");
    if (input.templateId && content) {
      throw new ToolError("A template fills in the page body itself: leave out content, or add it once the template has been applied.");
    }
    const templateId = input.templateId ? requireNotionId(input.templateId, "template_id") : null;
    const parent = await resolveParent(this.api, input.parentId);
    const extra = input.properties ?? {};
    let parentRef: PageParent;
    let properties: Record<string, unknown>;
    if (parent.kind === "page") {
      if (templateId) throw new ToolError("Templates belong to databases: use a database or data source as the parent.");
      const unsupported = Object.keys(extra).filter((key) => key !== "title");
      if (unsupported.length > 0) {
        throw new ToolError(`Pages under a page only have a title; remove properties: ${unsupported.join(", ")}.`);
      }
      parentRef = { type: "page_id", page_id: parent.page.id };
      properties = { title: { title: literalRichText(input.title) } };
    } else {
      const schema = parent.dataSource.properties;
      const titleName = titlePropertyName(parent.dataSource);
      if (!titleName) throw new ToolError("This data source has no title property.");
      const unknown = Object.keys(extra).filter((key) => !(key in schema));
      if (unknown.length > 0) {
        throw new ToolError(`Unknown properties: ${unknown.join(", ")}. Available: ${Object.keys(schema).join(", ")}.`);
      }
      if (titleName in extra) throw new ToolError(`Set the title with "title", not via properties["${titleName}"].`);
      parentRef = { type: "data_source_id", data_source_id: parent.dataSource.id };
      properties = { ...extra, [titleName]: { title: literalRichText(input.title) } };
      if (templateId) await this.assertTemplateOf(parent.dataSource.id, templateId);
    }

    const template: PageTemplate | undefined = templateId
      ? { type: "template_id", template_id: templateId, timezone: JST_TIME_ZONE }
      : undefined;
    const awaitBody = templateId !== null && (await this.templateHasBody(templateId));

    const parentId = parentRef.type === "page_id" ? parentRef.page_id : parentRef.data_source_id;
    const snapshot = toAuditJson(CreatePageSnapshotSchema, { parent: { type: parentRef.type, id: parentId } });
    const row = await this.begin(actor, {
      operation: "create_page",
      request: input.request,
      snapshot,
      targetPageId: null,
      targetUrl: null,
      targetTitle: input.title,
    });

    let page: NotionPage;
    try {
      page = await this.api.createPage({ parent: parentRef, properties, template });
    } catch (error) {
      return this.fail(row, error, `Look for a page titled ${JSON.stringify(input.title)} under the parent with notion_search`);
    }

    let warning: WriteWarning | null = null;
    // What the new page holds, to show what was created; null when nothing is known to be in it.
    let body: string | null = null;
    if (awaitBody) {
      const filled = await this.awaitTemplate(page.id);
      if (filled === null) warning = { kind: "template_pending" };
      else if (filled.truncated) warning = TRUNCATED_AFTER_CREATE;
      else body = filled.markdown;
    }
    if (content) {
      try {
        const written = await this.api.updatePageMarkdown(page.id, {
          type: "insert_content",
          insert_content: { content, position: { type: "end" } },
        });
        if (written.truncated) warning = TRUNCATED_AFTER_CREATE;
        else body = written.markdown;
      } catch (error) {
        warning = { kind: "content_failed", error: errorMessage(toToolError(error)) };
      }
    }
    return this.succeed(actor, row, "create_page", page, {
      result: toAuditJson(CreatePageResultSchema, { pageId: page.id, url: page.url }),
      warning,
      fallbackLastEdited: page.last_edited_time,
      content: body === null ? undefined : { before: "", after: body },
    });
  }

  async appendContent(
    actor: Actor,
    input: { pageId: string; content: string; position?: "start" | "end"; request: Record<string, unknown> },
  ): Promise<ContentWriteOutcome> {
    if (!input.content.trim()) throw new ToolError("Content is empty.");
    assertNoChildObjects(input.content, "content");
    return this.writeContent(actor, {
      operation: "append_content",
      pageId: input.pageId,
      request: input.request,
      update: { type: "insert_content", insert_content: { content: input.content, position: { type: input.position ?? "end" } } },
    });
  }

  async editContent(
    actor: Actor,
    input: { pageId: string; edits: ContentUpdate[]; request: Record<string, unknown> },
  ): Promise<ContentWriteOutcome> {
    if (input.edits.length === 0) throw new ToolError("No edits given.");
    if (input.edits.length > MAX_CONTENT_EDITS) throw new ToolError(`At most ${MAX_CONTENT_EDITS} edits per call.`);
    const updates = input.edits.map((edit, index): ContentUpdate => {
      if (!edit.old_str.trim()) throw new ToolError(`edits[${index}].old_str is empty.`);
      assertNoChildObjects(edit.new_str, `edits[${index}].new_str`);
      return { old_str: edit.old_str, new_str: edit.new_str };
    });
    return this.writeContent(
      actor,
      {
        operation: "edit_content",
        pageId: input.pageId,
        request: input.request,
        update: { type: "update_content", update_content: { content_updates: updates } },
      },
      EDIT_HINT,
    );
  }

  /**
   * Shared by append_content and edit_content: reads the content before the write, writes, and
   * keeps both versions. Revert puts the content before back as a whole, and only while the page
   * still hashes to `afterSha256`; that undoes exactly this write when the write changed nothing
   * else, which writeBlocker checks.
   */
  private async writeContent(
    actor: Actor,
    input: { operation: "append_content" | "edit_content"; pageId: string; request: Record<string, unknown>; update: PageMarkdownUpdate },
    failureHint?: string,
  ): Promise<ContentWriteOutcome> {
    const page = await this.api.retrievePage(input.pageId);
    const before = await this.api.retrievePageMarkdown(page.id);
    if (before.truncated) {
      throw new ToolError("This page is too large to edit revertibly (Notion returned truncated content), so it was not changed.");
    }
    const restoreSize = restoreBytes(before.markdown);
    if (restoreSize > MAX_RESTORE_BYTES) {
      throw new ToolError(
        `This page is too large to edit revertibly (a revert would send its ${Math.ceil(restoreSize / 1000)} KB of content back, more than Notion accepts at once), so it was not changed.`,
      );
    }
    const beforeSha256 = sha256(before.markdown);
    const row = await this.begin(actor, {
      operation: input.operation,
      request: input.request,
      snapshot: toAuditJson(ContentBeforeSnapshotSchema, { beforeSha256 }),
      targetPageId: page.id,
      targetUrl: page.url,
      targetTitle: pageTitle(page),
    });

    let after: EditedPageMarkdown;
    try {
      after = await this.api.updatePageMarkdown(page.id, input.update);
    } catch (error) {
      return this.fail(row, error, CHECK_PAGE, failureHint);
    }

    const missedEdits = after.warnings.filter((warning) => warning.code === NO_MATCH_WARNING).map((warning) => warning.message);
    for (const { code } of after.warnings) {
      if (code !== NO_MATCH_WARNING) this.reportError({ event: "notion_unknown_warning", pageId: page.id, code });
    }
    const snapshot: ContentSnapshot = { beforeSha256, afterSha256: null, revertBlocker: null };
    if (after.truncated) {
      snapshot.revertBlocker = "truncated_after_write";
    } else {
      snapshot.afterSha256 = sha256(after.markdown);
      // assertNoChildObjects lets no unescaped tag through, so a new child means Notion read the
      // write differently than it assumed; a revert could not remove it.
      const createdChild = countChildObjects(after.markdown) > countChildObjects(before.markdown);
      snapshot.revertBlocker =
        writeBlocker(before.markdown, after.markdown, input.update, missedEdits.length) ?? (createdChild ? "child_object_created" : null);
    }
    const warning: WriteWarning | null = snapshot.revertBlocker ? { kind: "revert_blocked", blocker: snapshot.revertBlocker } : null;
    const result: ContentWriteResult = { missedEdits };
    // No fallback timestamp: content reverts compare content hashes, and the server
    // clock would not be a real Notion last_edited_time.
    const outcome = await this.succeed(actor, row, input.operation, page, {
      result: toAuditJson(ContentWriteResultSchema, result),
      snapshot: toAuditJson(ContentSnapshotSchema, snapshot),
      warning,
      fallbackLastEdited: null,
      content: { before: before.markdown, after: after.truncated ? null : after.markdown },
    });
    return { ...outcome, ...result };
  }

  async updateProperties(
    actor: Actor,
    input: { pageId: string; properties: PropertyValues; request: Record<string, unknown> },
  ): Promise<WriteOutcome & { changed: string[] }> {
    const keys = Object.keys(input.properties);
    if (keys.length === 0) throw new ToolError("No properties to update.");
    const page = await this.api.retrievePage(input.pageId);
    const entries: PropertySnapshotEntry[] = [];
    // Sent keyed by the id as Notion returns it, as reverts do, whichever form of name or id was given.
    const properties = new Map<string, unknown>();
    for (const key of keys) {
      const found = Object.entries(page.properties).find(
        ([name, value]) => name === key || value.id === key || decodedPropertyId(value.id) === key,
      );
      if (!found) {
        throw new ToolError(`Unknown property "${key}". Available: ${Object.keys(page.properties).join(", ")}.`);
      }
      const [name, value] = found;
      if (properties.has(value.id)) throw new ToolError(`Property "${name}" is given more than once.`);
      properties.set(value.id, input.properties[key]);
      if (!WRITABLE_PROPERTY_TYPES.has(value.type)) {
        throw new ToolError(`Property "${name}" (${value.type}) cannot be written through this server.`);
      }
      const full = mayBeTruncated(value) ? valueFromPropertyItems(value, await this.api.retrievePropertyItems(page.id, value.id)) : value;
      const writable = toWritablePropertyValue(full);
      if (!writable.ok) {
        throw new ToolError(
          `Property "${name}" cannot be changed because the change could not be reverted: ${propertyWriteRefusalText(writable.refusal)}.`,
        );
      }
      entries.push({ name, id: value.id, type: value.type, value: full });
    }

    const row = await this.begin(actor, {
      operation: "update_properties",
      request: input.request,
      snapshot: toAuditJson(UpdatePropertiesSnapshotSchema, { properties: entries }),
      targetPageId: page.id,
      targetUrl: page.url,
      targetTitle: pageTitle(page),
    });
    let updated: NotionPage;
    try {
      updated = await this.api.updatePage({ pageId: page.id, properties: Object.fromEntries(properties) });
    } catch (error) {
      return this.fail(row, error, CHECK_PAGE);
    }
    const changed = entries.map((entry) => entry.name);
    const withAfter = await this.valuesAfterWrite(updated, entries);
    const outcome = await this.succeed(actor, row, "update_properties", page, {
      result: toAuditJson(UpdatePropertiesResultSchema, { changed }),
      ...(withAfter ? { snapshot: toAuditJson(UpdatePropertiesSnapshotSchema, { properties: withAfter }) } : {}),
      warning: null,
      fallbackLastEdited: updated.last_edited_time,
    });
    return { ...outcome, changed };
  }

  /**
   * Adds the values our write left, so a revert can tell later edits of these properties
   * apart. The write succeeded: when they cannot be read, revert falls back to edit times.
   */
  private async valuesAfterWrite(updated: NotionPage, entries: PropertySnapshotEntry[]): Promise<PropertySnapshotEntry[] | null> {
    try {
      return await Promise.all(
        entries.map(async (entry) => {
          const value = Object.values(updated.properties).find((candidate) => candidate.id === entry.id);
          if (!value) throw new Error(`property ${entry.name} missing from the update response`);
          const after = mayBeTruncated(value)
            ? valueFromPropertyItems(value, await this.api.retrievePropertyItems(updated.id, value.id))
            : value;
          return { ...entry, after };
        }),
      );
    } catch (error) {
      this.reportError({ event: "notion_readback_failed", pageId: updated.id, error: errorMessage(error) });
      return null;
    }
  }

  /**
   * The comment is posted before archiving because a trashed page may not accept comments;
   * if Notion refuses the archive, the comment is taken back so the page does not claim it.
   */
  async archivePage(actor: Actor, input: { pageId: string; request: Record<string, unknown> }): Promise<WriteOutcome> {
    const page = await this.api.retrievePage(input.pageId);
    if (page.in_trash) throw new ToolError("This page is already in the trash.");
    const row = await this.begin(actor, {
      operation: "archive_page",
      request: input.request,
      snapshot: toAuditJson(ArchivePageSnapshotSchema, { inTrash: false }),
      targetPageId: page.id,
      targetUrl: page.url,
      targetTitle: pageTitle(page),
    });
    const { commentId, commentError } = await postComment(this.api, page.id, writeComment(actor, "archive_page", row.id));
    let trashed: NotionPage;
    try {
      trashed = await this.api.updatePage({ pageId: page.id, inTrash: true });
    } catch (error) {
      if (writeMayHaveApplied(error)) {
        // The page may be in the trash now, so its attribution comment stays.
        await this.audit.finishPending(row.id, { status: "interrupted", error: errorMessage(error), commentError });
        throw unconfirmedWrite(error, row.id, "Check whether the page is in the trash with notion_get_page");
      }
      const retractError = commentId ? await retractComment(this.api, commentId) : null;
      await this.audit.finishPending(row.id, {
        status: "failed",
        error: errorMessage(error),
        commentError: retractError ? `The attribution comment could not be removed: ${retractError}` : commentError,
      });
      throw namingAuditRow(error, row.id);
    }
    await this.audit.finishPending(row.id, {
      status: "ok",
      result: toAuditJson(ArchivePageResultSchema, { inTrash: true }),
      commentError,
      resultLastEditedTime: trashed.last_edited_time,
    });
    return { auditId: row.id, pageId: page.id, url: page.url, commentError, warning: null };
  }
}
