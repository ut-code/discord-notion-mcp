interface AnnotationsRequest {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
}

export type RichTextRequest =
  | { type: "text"; text: { content: string; link?: { url: string } | null }; annotations?: AnnotationsRequest }
  | { type: "mention"; mention: Record<string, unknown>; annotations?: AnnotationsRequest }
  | { type: "equation"; equation: { expression: string }; annotations?: AnnotationsRequest };

export type PageParent = { type: "page_id"; page_id: string } | { type: "data_source_id"; data_source_id: string };

/** One search-and-replace of Notion's update_content: old_str must match exactly once. */
export interface ContentUpdate {
  old_str: string;
  new_str: string;
}

/**
 * Body of PATCH /v1/pages/:id/markdown, limited to the variants this server uses.
 * allow_deleting_content is intentionally not representable.
 */
export type PageMarkdownUpdate =
  | { type: "update_content"; update_content: { content_updates: ContentUpdate[] } }
  | { type: "insert_content"; insert_content: { content: string; position: { type: "start" | "end" } } };
