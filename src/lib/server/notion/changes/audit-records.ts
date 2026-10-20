import { z } from "zod";
import { isRecord } from "../../../guards";
import type { PagePropertyValue, PropertyWriteRefusal } from "../content/properties";
import type { RevertBlocker } from "./revert-reasons";

/*
 * Shapes of the JSON `snapshot` / `result` columns of notion_audit, per operation.
 * Writes serialize through these schemas and revert parses with them, so a row
 * whose JSON does not match is refused instead of being acted on blindly.
 */

export const ContentUpdateSchema = z.object({ old_str: z.string(), new_str: z.string() });

/** The parts of the `request` column (the tool arguments) shown for content writes whose content was not recorded. */
export const AppendContentRequestSchema = z.object({ content: z.string() });
/** Entries are checked one by one with ContentUpdateSchema so one malformed edit does not hide the rest. */
export const EditContentRequestSchema = z.object({ edits: z.array(z.unknown()) });
/** The requested values of update_properties, keyed by property name or id. */
export const UpdatePropertiesRequestSchema = z.object({ properties: z.record(z.string(), z.unknown()) });

const revertBlockerSchema = z.enum([
  "concurrent_edit",
  "unlocated_edit",
  "truncated_after_write",
  "child_object_created",
]) satisfies z.ZodType<RevertBlocker>;

const propertyValueSchema = z.custom<PagePropertyValue>(
  (value) => isRecord(value) && typeof value.type === "string",
  "expected a Notion property value",
);

export const CreatePageSnapshotSchema = z.object({
  parent: z.object({ type: z.enum(["page_id", "data_source_id"]), id: z.string() }),
});

export const CreatePageResultSchema = z.object({ pageId: z.string(), url: z.string() });
export type CreatePageResult = z.infer<typeof CreatePageResultSchema>;

/**
 * Snapshot of append_content / edit_content. The content itself is in notion_audit_content: revert
 * puts `before` back while the page still hashes to `afterSha256`.
 */
export const ContentSnapshotSchema = z.object({
  beforeSha256: z.string(),
  /** Hash of the markdown returned by the write; null when it could not be determined. */
  afterSha256: z.string().nullable(),
  /** Set when the change cannot be reverted automatically. */
  revertBlocker: revertBlockerSchema.nullable(),
});
export type ContentSnapshot = z.infer<typeof ContentSnapshotSchema>;

/** A content write as recorded before it runs (and kept when it fails): the hash of the content it applies to. */
export const ContentBeforeSnapshotSchema = ContentSnapshotSchema.pick({ beforeSha256: true });

/** Notion's message for each edit it found no match for (and so did not apply), in its order. */
export const ContentWriteResultSchema = z.object({ missedEdits: z.array(z.string()) });
export type ContentWriteResult = z.infer<typeof ContentWriteResultSchema>;

const PropertySnapshotEntrySchema = z.object({
  name: z.string(),
  id: z.string(),
  type: z.string(),
  /** The value before the write, which revert restores. */
  value: propertyValueSchema,
  /** The value our write left, to tell later edits apart; absent when it could not be read back. */
  after: propertyValueSchema.optional(),
});
export type PropertySnapshotEntry = z.infer<typeof PropertySnapshotEntrySchema>;

export const UpdatePropertiesSnapshotSchema = z.object({ properties: z.array(PropertySnapshotEntrySchema) });
export type UpdatePropertiesSnapshot = z.infer<typeof UpdatePropertiesSnapshotSchema>;

export const UpdatePropertiesResultSchema = z.object({ changed: z.array(z.string()) });

export const ArchivePageSnapshotSchema = z.object({ inTrash: z.boolean() });

export const ArchivePageResultSchema = z.object({ inTrash: z.boolean() });

const PropertyWriteRefusalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hosted_files"), files: z.array(z.string()) }),
  z.object({ kind: z.literal("unsupported_type"), type: z.string() }),
]) satisfies z.ZodType<PropertyWriteRefusal>;

const PropertySkipSchema = z.object({ name: z.string(), refusal: PropertyWriteRefusalSchema });
export type PropertySkip = z.infer<typeof PropertySkipSchema>;

/** A successful write that needs a word of caution. */
const WriteWarningSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("content_failed"), error: z.string() }),
  z.object({ kind: z.literal("revert_blocked"), blocker: revertBlockerSchema }),
]);
export type WriteWarning = z.infer<typeof WriteWarningSchema>;

/** What a successful revert wants the reader to know. */
const RevertNoteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("already_in_trash") }),
  z.object({ kind: z.literal("nothing_to_restore") }),
  z.object({ kind: z.literal("content_differs") }),
  z.object({ kind: z.literal("already_restored") }),
  z.object({ kind: z.literal("properties_partial"), restored: z.array(z.string()), skipped: z.array(PropertySkipSchema) }),
]);
export type RevertNote = z.infer<typeof RevertNoteSchema>;

/** The `note` of a row and the `revert_note` of a reverted row. */
export const AuditNoteSchema = z.union([WriteWarningSchema, RevertNoteSchema]);

/** Validates a value against its column schema and returns it as stored JSON. */
export function toAuditJson<S extends z.ZodType<Record<string, unknown>>>(schema: S, value: z.input<S>): Record<string, unknown> {
  return schema.parse(value);
}
