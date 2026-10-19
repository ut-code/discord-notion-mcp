import {
  Client,
  ClientErrorCode,
  isFullComment,
  isFullDatabase,
  isFullDataSource,
  isFullPage,
  isHTTPResponseError,
  isNotionClientError,
  type CommentObjectResponse,
  type CreatePageParameters,
  type DatabaseObjectResponse,
  type DataSourceObjectResponse,
  type PageObjectResponse,
  type PropertyItemObjectResponse,
  type QueryDataSourceParameters,
  type CreateCommentParameters,
  type UpdatePageParameters,
} from "@notionhq/client";
import { createLimiter, type Limiter } from "../../lib/limiter";
import type { PageMarkdownUpdate, PageParent, RichTextRequest } from "./types";

/**
 * Notion API version this server targets. Since 2025-09-03 databases contain one or
 * more data sources (queries and page parents use data source ids); 2026-03-11
 * replaced `archived` with `in_trash`.
 */
const NOTION_API_VERSION = "2026-03-11";

const MAX_CONCURRENT_REQUESTS = 3;

export type NotionPage = PageObjectResponse;
export type NotionDatabase = DatabaseObjectResponse;
export type NotionDataSource = DataSourceObjectResponse;
export type NotionComment = CommentObjectResponse;
export type SearchResult = NotionPage | NotionDataSource;

export interface Paged<T> {
  results: T[];
  nextCursor: string | null;
}

/** A page's content in Notion's enhanced Markdown (markdown endpoints). */
export interface PageMarkdown {
  markdown: string;
  /** The page was too large to render completely. */
  truncated: boolean;
  /** Blocks that could not be rendered (e.g. beyond the truncation point). */
  unknownBlockIds: string[];
}

export interface CursorQuery {
  startCursor?: string;
  pageSize: number;
}

/** Errors from the Notion API, normalized so callers (and fakes) do not depend on SDK classes. */
export class NotionRequestError extends Error {
  override name = "NotionRequestError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Not found, not shared with the integration, or the wrong object type for the endpoint. */
export function isNotionMiss(error: unknown): boolean {
  return error instanceof NotionRequestError && (error.status === 404 || error.status === 400 || error.status === 403);
}

// NotionRequestError keeps the SDK's codes as plain strings.
const REQUEST_TIMEOUT: string = ClientErrorCode.RequestTimeout;
const INVALID_PATH_PARAMETER: string = ClientErrorCode.InvalidPathParameter;

/** Notion failed on its side or did not answer in time: the same request may succeed later. */
export function isNotionUnavailable(error: unknown): boolean {
  return error instanceof NotionRequestError && (error.status >= 500 || error.code === REQUEST_TIMEOUT);
}

/** What went wrong talking to Notion, without its message (which may quote page text). */
export function notionFailure(error: unknown): string {
  if (!(error instanceof NotionRequestError)) return "no response";
  if (error.status === 0) return error.code === REQUEST_TIMEOUT ? "timed out" : error.code;
  return `HTTP ${error.status}`;
}

/**
 * Whether a write that threw `error` may still have been applied. Only a refusal (4xx) or a
 * request the SDK never sent is known not to have been; a 5xx, a timeout, a lost connection
 * or an unreadable response leave it open.
 */
export function writeMayHaveApplied(error: unknown): boolean {
  if (!(error instanceof NotionRequestError)) return true;
  if (error.status === 0) return error.code !== INVALID_PATH_PARAMETER;
  return error.status >= 500;
}

/** Every Notion HTTP operation the tools, write service and revert need. */
export interface NotionApi {
  search(query: { query: string; filter?: "page" | "data_source" } & CursorQuery): Promise<Paged<SearchResult>>;
  retrievePage(pageId: string): Promise<NotionPage>;
  /** All items of a paginated page property (title, rich_text, people, relation beyond 25 entries). */
  retrievePropertyItems(pageId: string, propertyId: string): Promise<PropertyItemObjectResponse[]>;
  retrievePageMarkdown(pageId: string): Promise<PageMarkdown>;
  /** Edits page content; returns the full resulting markdown. */
  updatePageMarkdown(pageId: string, update: PageMarkdownUpdate): Promise<PageMarkdown>;
  /** The user's display name, or null when it has none. */
  retrieveUser(userId: string): Promise<string | null>;
  retrieveDatabase(databaseId: string): Promise<NotionDatabase>;
  retrieveDataSource(dataSourceId: string): Promise<NotionDataSource>;
  queryDataSource(
    query: { dataSourceId: string; filter?: Record<string, unknown>; sorts?: Array<Record<string, unknown>> } & CursorQuery,
  ): Promise<Paged<NotionPage>>;
  listComments(blockId: string, query: CursorQuery): Promise<Paged<NotionComment>>;
  createPage(params: { parent: PageParent; properties: Record<string, unknown> }): Promise<NotionPage>;
  updatePage(params: { pageId: string; properties?: Record<string, unknown>; inTrash?: boolean }): Promise<NotionPage>;
  /** `displayName` is shown as the comment's author. */
  createComment(params: { pageId: string; richText: RichTextRequest[]; displayName: string }): Promise<{ id: string }>;
  /** Only comments this integration created can be deleted. */
  deleteComment(commentId: string): Promise<void>;
}

function translateError(error: unknown): unknown {
  if (isHTTPResponseError(error)) return new NotionRequestError(error.message, error.status, error.code);
  if (isNotionClientError(error)) return new NotionRequestError(error.message, 0, error.code);
  return error;
}

function expectFull<R, T extends R>(value: R, guard: (value: R) => value is T, what: string): T {
  if (!guard(value)) throw new NotionRequestError(`Notion returned a partial ${what} object.`, 0, "partial_response");
  return value;
}

/**
 * Request JSON built from tool input or stored snapshots goes to the SDK as-is: its
 * request unions are finer than the loosely typed JSON, and Notion validates the body.
 */
function sdkRequest<T>(value: unknown): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- trust boundary: loosely typed request JSON is validated by the Notion API
  return value as T;
}

/**
 * NotionApi over the official SDK. The SDK already retries 429 (honoring Retry-After)
 * and 529 for every method, and 500/503 for idempotent ones; this class adds a
 * concurrency cap shared by all callers.
 */
export class SdkNotionApi implements NotionApi {
  private readonly client: Client;
  private readonly limit: Limiter;

  constructor(token: string, options: { client?: Client; maxConcurrent?: number } = {}) {
    this.client =
      options.client ?? new Client({ auth: token, notionVersion: NOTION_API_VERSION, retry: { maxRetries: 3, maxRetryDelayMs: 30_000 } });
    this.limit = createLimiter(options.maxConcurrent ?? MAX_CONCURRENT_REQUESTS);
  }

  private async call<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await this.limit(task);
    } catch (error) {
      throw translateError(error);
    }
  }

  async search(query: { query: string; filter?: "page" | "data_source" } & CursorQuery): Promise<Paged<SearchResult>> {
    const response = await this.call(() =>
      this.client.search({
        query: query.query,
        page_size: query.pageSize,
        start_cursor: query.startCursor,
        filter: query.filter ? { property: "object", value: query.filter } : undefined,
      }),
    );
    const results = response.results.filter((item): item is SearchResult => isFullPage(item) || isFullDataSource(item));
    return { results, nextCursor: response.next_cursor };
  }

  async retrievePage(pageId: string): Promise<NotionPage> {
    const page = await this.call(() => this.client.pages.retrieve({ page_id: pageId }));
    return expectFull(page, isFullPage, "page");
  }

  async retrievePropertyItems(pageId: string, propertyId: string): Promise<PropertyItemObjectResponse[]> {
    const items: PropertyItemObjectResponse[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const response = await this.call(() =>
        this.client.pages.properties.retrieve({ page_id: pageId, property_id: propertyId, start_cursor: cursor, page_size: 100 }),
      );
      if (response.object !== "list") return [response];
      items.push(...response.results);
      if (!response.has_more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }
    return items;
  }

  async retrievePageMarkdown(pageId: string): Promise<PageMarkdown> {
    const response = await this.call(() => this.client.pages.retrieveMarkdown({ page_id: pageId }));
    return { markdown: response.markdown, truncated: response.truncated, unknownBlockIds: response.unknown_block_ids };
  }

  async updatePageMarkdown(pageId: string, update: PageMarkdownUpdate): Promise<PageMarkdown> {
    const response = await this.call(() => this.client.pages.updateMarkdown({ page_id: pageId, ...update }));
    return { markdown: response.markdown, truncated: response.truncated, unknownBlockIds: response.unknown_block_ids };
  }

  async retrieveUser(userId: string): Promise<string | null> {
    const user = await this.call(() => this.client.users.retrieve({ user_id: userId }));
    return user.name ?? null;
  }

  async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    const database = await this.call(() => this.client.databases.retrieve({ database_id: databaseId }));
    return expectFull(database, isFullDatabase, "database");
  }

  async retrieveDataSource(dataSourceId: string): Promise<NotionDataSource> {
    const dataSource = await this.call(() => this.client.dataSources.retrieve({ data_source_id: dataSourceId }));
    return expectFull(dataSource, isFullDataSource, "data source");
  }

  async queryDataSource(
    query: { dataSourceId: string; filter?: Record<string, unknown>; sorts?: Array<Record<string, unknown>> } & CursorQuery,
  ): Promise<Paged<NotionPage>> {
    const response = await this.call(() =>
      this.client.dataSources.query({
        data_source_id: query.dataSourceId,
        filter: sdkRequest<QueryDataSourceParameters["filter"]>(query.filter),
        sorts: sdkRequest<QueryDataSourceParameters["sorts"]>(query.sorts),
        page_size: query.pageSize,
        start_cursor: query.startCursor,
        result_type: "page",
      }),
    );
    return { results: response.results.filter(isFullPage), nextCursor: response.next_cursor };
  }

  async listComments(blockId: string, query: CursorQuery): Promise<Paged<NotionComment>> {
    const response = await this.call(() =>
      this.client.comments.list({ block_id: blockId, start_cursor: query.startCursor, page_size: query.pageSize }),
    );
    return { results: response.results.filter(isFullComment), nextCursor: response.next_cursor };
  }

  async createPage(params: { parent: PageParent; properties: Record<string, unknown> }): Promise<NotionPage> {
    const page = await this.call(() =>
      this.client.pages.create({
        parent: params.parent,
        properties: sdkRequest<CreatePageParameters["properties"]>(params.properties),
      }),
    );
    return expectFull(page, isFullPage, "page");
  }

  async updatePage(params: { pageId: string; properties?: Record<string, unknown>; inTrash?: boolean }): Promise<NotionPage> {
    const page = await this.call(() =>
      this.client.pages.update({
        page_id: params.pageId,
        properties: sdkRequest<UpdatePageParameters["properties"]>(params.properties),
        in_trash: params.inTrash,
      }),
    );
    return expectFull(page, isFullPage, "page");
  }

  async createComment(params: { pageId: string; richText: RichTextRequest[]; displayName: string }): Promise<{ id: string }> {
    const comment = await this.call(() =>
      this.client.comments.create({
        parent: { page_id: params.pageId },
        rich_text: sdkRequest<Extract<CreateCommentParameters, { rich_text: unknown }>["rich_text"]>(params.richText),
        display_name: { type: "custom", custom: { name: params.displayName } },
      }),
    );
    return { id: comment.id };
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.call(() => this.client.comments.delete({ comment_id: commentId }));
  }
}
