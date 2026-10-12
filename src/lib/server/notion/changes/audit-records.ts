import { z } from "zod";
import type { ContentHunk } from "../content/content-diff";
import type { PagePropertyValue } from "../content/properties";
import type { PageMarkdownUpdate } from "../client/types";

/*
 * Shapes of the JSON `snapshot` / `result` columns of notion_audit, per operation.
 * Writes serialize through these schemas and revert parses with them, so a row
 * whose JSON does not match is refused instead of being acted on blindly.
 */

export const ContentUpdateSchema = z.object({ old_str: z.string(), new_str: z.string() });

/** The parts of the `request` column (the tool arguments) shown for failed content writes, which have no hunks. */
export const AppendContentRequestSchema = z.object({ content: z.string() });
/** Entries are checked one by one with ContentUpdateSchema so one malformed edit does not hide the rest. */
export const EditContentRequestSchema = z.object({ edits: z.array(z.unknown()) });

const pageMarkdownUpdateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("update_content"),
    update_content: z.object({ content_updates: z.array(ContentUpdateSchema) }),
  }),
  z.object({
    type: z.literal("insert_content"),
    insert_content: z.object({ content: z.string(), position: z.object({ type: z.enum(["start", "end"]) }) }),
  }),
]) satisfies z.ZodType<PageMarkdownUpdate>;

const contentHunkSchema = z.object({ before: z.string(), after: z.string() }) satisfies z.ZodType<ContentHunk>;

const propertyValueSchema = z.custom<PagePropertyValue>(
  (value) => typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string",
  "expected a Notion property value",
);

export const CreatePageSnapshotSchema = z.object({
  parent: z.object({ type: z.enum(["page_id", "data_source_id"]), id: z.string() }),
});
export type CreatePageSnapshot = z.infer<typeof CreatePageSnapshotSchema>;

export const CreatePageResultSchema = z.object({ pageId: z.string(), url: z.string() });
export type CreatePageResult = z.infer<typeof CreatePageResultSchema>;

/** Snapshot of append_content / edit_content: what revert needs, without whole-page copies. */
export const ContentSnapshotSchema = z.object({
  beforeSha256: z.string(),
  /** Hash of the markdown returned by the write; null when it could not be determined. */
  afterSha256: z.string().nullable(),
  /** The update that restores the previous content; null when there is nothing to restore or it cannot be computed. */
  inverse: pageMarkdownUpdateSchema.nullable(),
  /** Set when the change cannot be reverted automatically. */
  revertBlocker: z.string().nullable(),
  hunks: z.array(contentHunkSchema),
});
export type ContentSnapshot = z.infer<typeof ContentSnapshotSchema>;

/** A content write that failed only records the hash of the content it was applied to. */
export const FailedContentSnapshotSchema = ContentSnapshotSchema.pick({ beforeSha256: true });

export const ContentWriteResultSchema = z.object({ changedHunks: z.number().int().nonnegative() });
export type ContentWriteResult = z.infer<typeof ContentWriteResultSchema>;

export const PropertySnapshotEntrySchema = z.object({
  name: z.string(),
  id: z.string(),
  type: z.string(),
  value: propertyValueSchema,
});
export type PropertySnapshotEntry = z.infer<typeof PropertySnapshotEntrySchema>;

export const UpdatePropertiesSnapshotSchema = z.object({ properties: z.array(PropertySnapshotEntrySchema) });
export type UpdatePropertiesSnapshot = z.infer<typeof UpdatePropertiesSnapshotSchema>;

export const UpdatePropertiesResultSchema = z.object({ changed: z.array(z.string()) });

export const ArchivePageSnapshotSchema = z.object({ inTrash: z.boolean() });
export type ArchivePageSnapshot = z.infer<typeof ArchivePageSnapshotSchema>;

export const ArchivePageResultSchema = z.object({ inTrash: z.boolean() });

/** Validates a value against its column schema and returns it as stored JSON. */
export function toAuditJson<S extends z.ZodType<Record<string, unknown>>>(schema: S, value: z.input<S>): Record<string, unknown> {
  return schema.parse(value);
}
