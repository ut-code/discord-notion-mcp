import { errorMessage, ToolError } from "../../lib/errors";
import type { NotionApi, NotionPage, PageMarkdown } from "../client/api";
import { notionUrlFor } from "../client/ids";
import { resolveParent, toToolError } from "../client/resolve";
import type { ContentUpdate, PageMarkdownUpdate, PageParent } from "../client/types";
import { buildRevertPlan, sha256 } from "../content/content-diff";
import { assertNoChildObjects, stripUserMentionLabels } from "../content/enhanced-markdown";
import {
  mayBeTruncated,
  pageTitle,
  propertyWriteRefusalText,
  titlePropertyName,
  toWritablePropertyValue,
  valueFromPropertyItems,
  WRITABLE_PROPERTY_TYPES,
} from "../content/properties";
import { literalRichText } from "../content/rich-text";
import { postComment, writeCommentText, type Actor, type WriteOperation } from "./attribution";
import { revertBlockerText, type RevertBlocker } from "./revert-reasons";
import {
  ArchivePageResultSchema,
  ArchivePageSnapshotSchema,
  ContentSnapshotSchema,
  ContentWriteResultSchema,
  CreatePageResultSchema,
  CreatePageSnapshotSchema,
  FailedContentSnapshotSchema,
  toAuditJson,
  UpdatePropertiesResultSchema,
  UpdatePropertiesSnapshotSchema,
  type ContentSnapshot,
  type ContentWriteResult,
  type WriteWarning,
  type PropertySnapshotEntry,
} from "./audit-records";
import type { NotionAuditStore } from "./audit-store";

export type PropertyValues = Record<string, Record<string, unknown>>;

export interface WriteOutcome {
  auditId: number;
  pageId: string;
  url: string;
  commentError: string | null;
  /** Set when the write was only partially applied or cannot be reverted automatically (still recorded). */
  warning: WriteWarning | null;
}

export function writeWarningText(warning: WriteWarning): string {
  switch (warning.kind) {
    case "content_failed":
      return `Page created, but adding its content failed: ${warning.error}`;
    case "revert_blocked":
      return warning.blocker === ("truncated_after_write" satisfies RevertBlocker)
        ? `The change was applied, but automatic revert may not be possible: ${revertBlockerText(warning.blocker)}.`
        : `The change was applied, but automatic revert is not possible: ${revertBlockerText(warning.blocker)}.`;
    default:
      throw new Error(`Unknown write warning: ${warning satisfies never}`);
  }
}
export type ContentWriteOutcome = WriteOutcome & ContentWriteResult;

interface AuditBase {
  operation: WriteOperation;
  request: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  targetPageId: string | null;
  targetUrl: string | null;
  targetTitle: string | null;
}

export const MAX_CONTENT_EDITS = 20;

const EDIT_HINT =
  "Call notion_get_page and copy old_str exactly from the current content; include more surrounding text when it matches several places.";

/** Validates content written to a page and normalizes labeled user mentions. */
function prepareContent(content: string, field: string): string {
  assertNoChildObjects(content, field);
  return stripUserMentionLabels(content);
}

/**
 * Executes the allowed Notion writes. Each write snapshots what is needed to revert
 * it, executes, records an audit row and comments on the affected page to attribute
 * the change to the Discord user. Comment failures never fail a write.
 */
export class NotionWriteService {
  constructor(
    private readonly api: NotionApi,
    private readonly audit: NotionAuditStore,
  ) {}

  private actorColumns(actor: Actor) {
    return {
      discordUserId: actor.discordUserId,
      discordDisplayName: actor.displayName,
      discordUsername: actor.username,
    };
  }

  private async recordFailure(actor: Actor, base: AuditBase, error: unknown, hint?: string): Promise<never> {
    const row = await this.audit.insert({ ...this.actorColumns(actor), ...base, status: "failed", error: errorMessage(error) });
    const mapped = toToolError(error);
    if (mapped instanceof ToolError) throw new ToolError(`${mapped.message} (audit #${row.id})${hint ? ` ${hint}` : ""}`);
    throw error;
  }

  /**
   * Records a successful write, comments, then stores the page's last_edited_time after
   * all our changes. `fallbackLastEdited` is kept when the page cannot be read back;
   * null when no trustworthy value is known.
   */
  private async recordSuccess(
    actor: Actor,
    base: AuditBase & { targetPageId: string },
    result: Record<string, unknown>,
    fallbackLastEdited: string | null,
    warning: WriteWarning | null,
  ): Promise<WriteOutcome> {
    const row = await this.audit.insert({
      ...this.actorColumns(actor),
      ...base,
      result,
      status: "ok",
      error: warning ? JSON.stringify(warning) : null,
      resultLastEditedTime: fallbackLastEdited,
    });
    const commentError = await postComment(this.api, base.targetPageId, writeCommentText(actor, base.operation, row.id));
    const final = await this.api.retrievePage(base.targetPageId).catch(() => null);
    const url = final?.url ?? base.targetUrl ?? notionUrlFor(base.targetPageId);
    await this.audit.recordAttribution(row.id, {
      commentError,
      targetUrl: url,
      resultLastEditedTime: final?.last_edited_time ?? fallbackLastEdited,
    });
    return { auditId: row.id, pageId: base.targetPageId, url, commentError, warning };
  }

  /**
   * Creates the page from properties only, then inserts the content at its end: a
   * leading "# H1" in markdown passed to page creation would be consumed as the title.
   */
  async createPage(
    actor: Actor,
    input: { parentId: string; title: string; properties?: PropertyValues; content?: string; request: Record<string, unknown> },
  ): Promise<WriteOutcome> {
    const content = input.content?.trim() ? prepareContent(input.content, "content") : null;
    const parent = await resolveParent(this.api, input.parentId);
    const extra = input.properties ?? {};
    let parentRef: PageParent;
    let properties: Record<string, unknown>;
    if (parent.kind === "page") {
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
    }

    const parentId = parentRef.type === "page_id" ? parentRef.page_id : parentRef.data_source_id;
    const snapshot = toAuditJson(CreatePageSnapshotSchema, { parent: { type: parentRef.type, id: parentId } });
    const base = { operation: "create_page" as const, request: input.request, snapshot, targetTitle: input.title };

    let page: NotionPage;
    try {
      page = await this.api.createPage({ parent: parentRef, properties });
    } catch (error) {
      return this.recordFailure(actor, { ...base, targetPageId: null, targetUrl: null }, error);
    }

    let warning: WriteWarning | null = null;
    if (content) {
      try {
        await this.api.updatePageMarkdown(page.id, {
          type: "insert_content",
          insert_content: { content, position: { type: "end" } },
        });
      } catch (error) {
        warning = { kind: "content_failed", error: errorMessage(toToolError(error)) };
      }
    }
    return this.recordSuccess(
      actor,
      { ...base, targetPageId: page.id, targetUrl: page.url },
      toAuditJson(CreatePageResultSchema, { pageId: page.id, url: page.url }),
      page.last_edited_time,
      warning,
    );
  }

  async appendContent(
    actor: Actor,
    input: { pageId: string; content: string; position?: "start" | "end"; request: Record<string, unknown> },
  ): Promise<ContentWriteOutcome> {
    if (!input.content.trim()) throw new ToolError("Content is empty.");
    const content = prepareContent(input.content, "content");
    return this.writeContent(actor, {
      operation: "append_content",
      pageId: input.pageId,
      request: input.request,
      update: { type: "insert_content", insert_content: { content, position: { type: input.position ?? "end" } } },
    });
  }

  async editContent(
    actor: Actor,
    input: { pageId: string; edits: ContentUpdate[]; request: Record<string, unknown> },
  ): Promise<ContentWriteOutcome> {
    if (input.edits.length === 0) throw new ToolError("No edits given.");
    if (input.edits.length > MAX_CONTENT_EDITS) throw new ToolError(`At most ${MAX_CONTENT_EDITS} edits per call.`);
    const updates = input.edits.map((edit, index): ContentUpdate => {
      const oldStr = stripUserMentionLabels(edit.old_str);
      if (!oldStr.trim()) throw new ToolError(`edits[${index}].old_str is empty.`);
      return { old_str: oldStr, new_str: prepareContent(edit.new_str, `edits[${index}].new_str`) };
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
   * Shared by append_content and edit_content: reads the content before the write,
   * writes, and stores an inverse update computed from a line diff of the markdown
   * before and after (the write response). Revert applies it only while the page
   * content still hashes to `afterSha256` (or when forced).
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
    const beforeSha256 = sha256(before.markdown);
    const base = {
      operation: input.operation,
      request: input.request,
      targetPageId: page.id,
      targetUrl: page.url,
      targetTitle: pageTitle(page),
    };

    let after: PageMarkdown;
    try {
      after = await this.api.updatePageMarkdown(page.id, input.update);
    } catch (error) {
      return this.recordFailure(
        actor,
        { ...base, snapshot: toAuditJson(FailedContentSnapshotSchema, { beforeSha256 }) },
        error,
        failureHint,
      );
    }

    const snapshot: ContentSnapshot = { beforeSha256, afterSha256: null, inverse: null, revertBlocker: null, hunks: [] };
    let warning: WriteWarning | null = null;
    if (after.truncated) {
      snapshot.revertBlocker = "truncated_after_write" satisfies RevertBlocker;
      warning = { kind: "revert_blocked", blocker: snapshot.revertBlocker };
    } else {
      snapshot.afterSha256 = sha256(after.markdown);
      const plan = buildRevertPlan(before.markdown, after.markdown);
      if (plan.kind === "revertible") {
        snapshot.inverse = plan.inverse;
        snapshot.hunks = plan.hunks;
      } else if (plan.kind === "unsupported") {
        snapshot.hunks = plan.hunks;
        snapshot.revertBlocker = plan.blocker;
        warning = { kind: "revert_blocked", blocker: plan.blocker };
      }
    }
    const result: ContentWriteResult = { changedHunks: snapshot.hunks.length };
    // No fallback timestamp: content reverts compare content hashes, and the server
    // clock would not be a real Notion last_edited_time.
    const outcome = await this.recordSuccess(
      actor,
      { ...base, snapshot: toAuditJson(ContentSnapshotSchema, snapshot) },
      toAuditJson(ContentWriteResultSchema, result),
      null,
      warning,
    );
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
    for (const key of keys) {
      const found = Object.entries(page.properties).find(
        ([name, value]) => name === key || value.id === key || decodeURIComponent(value.id) === key,
      );
      if (!found) {
        throw new ToolError(`Unknown property "${key}". Available: ${Object.keys(page.properties).join(", ")}.`);
      }
      const [name, value] = found;
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

    const base = {
      operation: "update_properties" as const,
      request: input.request,
      snapshot: toAuditJson(UpdatePropertiesSnapshotSchema, { properties: entries }),
      targetPageId: page.id,
      targetUrl: page.url,
      targetTitle: pageTitle(page),
    };
    let updated: NotionPage;
    try {
      updated = await this.api.updatePage({ pageId: page.id, properties: input.properties });
    } catch (error) {
      return this.recordFailure(actor, base, error);
    }
    const changed = entries.map((entry) => entry.name);
    const outcome = await this.recordSuccess(
      actor,
      base,
      toAuditJson(UpdatePropertiesResultSchema, { changed }),
      updated.last_edited_time,
      null,
    );
    return { ...outcome, changed };
  }

  /** The comment is posted before archiving because a trashed page may not accept comments. */
  async archivePage(actor: Actor, input: { pageId: string; request: Record<string, unknown> }): Promise<WriteOutcome> {
    const page = await this.api.retrievePage(input.pageId);
    if (page.in_trash) throw new ToolError("This page is already in the trash.");
    const row = await this.audit.insert({
      ...this.actorColumns(actor),
      operation: "archive_page",
      request: input.request,
      snapshot: toAuditJson(ArchivePageSnapshotSchema, { inTrash: false }),
      targetPageId: page.id,
      targetUrl: page.url,
      targetTitle: pageTitle(page),
      status: "pending",
    });
    const commentError = await postComment(this.api, page.id, writeCommentText(actor, "archive_page", row.id));
    let trashed: NotionPage;
    try {
      trashed = await this.api.updatePage({ pageId: page.id, inTrash: true });
    } catch (error) {
      await this.audit.finishPending(row.id, { status: "failed", error: errorMessage(error), commentError });
      const mapped = toToolError(error);
      if (mapped instanceof ToolError) throw new ToolError(`${mapped.message} (audit #${row.id})`);
      throw error;
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
