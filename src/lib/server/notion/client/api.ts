import {
  APIErrorCode,
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
import { isRecord } from "../../../guards";
import { createLimiter, type Limiter } from "../../lib/limiter";
import type { PageMarkdownUpdate, PageParent, RichTextRequest } from "./types";

/**
 * Notion API version this server targets. Since 2025-09-03 databases contain one or
 * more data sources (queries and page parents use data source ids); 2026-03-11
 * replaced `archived` with `in_trash`.
 */
const NOTION_API_VERSION = "2026-03-11";

const MAX_CONCURRENT_REQUESTS = 3;

/** Reads that Notion failed on its side are retried after 1 s, 2 s and 4 s. */
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
/**
 * A rate limit is waited out once when Notion asks for at most this long, as the official
 * Notion MCP does; a longer one fails at once so the caller can say when to retry.
 */
const MAX_RATE_LIMIT_WAIT_MS = 2000;

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

/** A workspace member, guest or bot. Emails are not read (the integration does not need them). */
export interface NotionUser {
  id: string;
  name: string | null;
  type: "person" | "bot";
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
    /** For a rate limit (429): how long Notion asked to wait, when it said. */
    readonly retryAfterMs?: number,
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
const RATE_LIMITED: string = APIErrorCode.RateLimited;
/** Notion failed on its side; a read is safe to repeat, a write may already have been applied. */
const SERVER_FAILURES: ReadonlySet<string> = new Set([
  APIErrorCode.InternalServerError,
  APIErrorCode.ServiceUnavailable,
  APIErrorCode.ServiceOverload,
]);

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
  retrieveUser(userId: string): Promise<NotionUser>;
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
  if (isHTTPResponseError(error)) return new NotionRequestError(error.message, error.status, error.code, retryAfterMs(error.headers));
  if (isNotionClientError(error)) return new NotionRequestError(error.message, 0, error.code);
  return error;
}

/** Retry-After in milliseconds (delta-seconds or an HTTP date), when the response has a valid one. */
function retryAfterMs(headers: unknown): number | undefined {
  const value =
    headers instanceof Headers
      ? headers.get("retry-after")
      : isRecord(headers)
        ? Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1]
        : undefined;
  if (typeof value !== "string") return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * How long to wait before repeating a request that failed with `error`, or null when it
 * must not be repeated. A rate limit (429) means Notion did nothing, so any request may
 * be repeated; after a server failure only reads are, since a write may have been applied.
 */
function retryDelayMs(error: unknown, kind: "read" | "write", attempt: number): number | null {
  if (!isHTTPResponseError(error)) return null;
  const code: string = error.code;
  if (code === RATE_LIMITED) {
    const wait = retryAfterMs(error.headers);
    return attempt === 0 && wait !== undefined && wait <= MAX_RATE_LIMIT_WAIT_MS ? wait : null;
  }
  return kind === "read" && SERVER_FAILURES.has(code) ? INITIAL_RETRY_DELAY_MS * 2 ** attempt : null;
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
 * NotionApi over the official SDK, with a concurrency cap shared by all callers. Retries are
 * done here, not by the SDK: it repeats 429 and 529 for every method, and repeating a write
 * Notion may have applied could apply it twice, or record it as failed when it was not.
 */
export class SdkNotionApi implements NotionApi {
  private readonly client: Client;
  private readonly limit: Limiter;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(token: string, options: { client?: Client; maxConcurrent?: number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.client = options.client ?? new Client({ auth: token, notionVersion: NOTION_API_VERSION, retry: false });
    this.limit = createLimiter(options.maxConcurrent ?? MAX_CONCURRENT_REQUESTS);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Runs `task` in a limiter slot, waiting between retries without holding one. */
  private async call<T>(task: () => Promise<T>, kind: "read" | "write"): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.limit(task);
      } catch (error) {
        const delayMs = attempt < MAX_RETRIES ? retryDelayMs(error, kind, attempt) : null;
        if (delayMs === null) throw translateError(error);
        await this.sleep(delayMs);
      }
    }
  }

  async search(query: { query: string; filter?: "page" | "data_source" } & CursorQuery): Promise<Paged<SearchResult>> {
    const response = await this.call(
      () =>
        this.client.search({
          query: query.query,
          page_size: query.pageSize,
          start_cursor: query.startCursor,
          filter: query.filter ? { property: "object", value: query.filter } : undefined,
        }),
      "read",
    );
    const results = response.results.filter((item): item is SearchResult => isFullPage(item) || isFullDataSource(item));
    return { results, nextCursor: response.next_cursor };
  }

  async retrievePage(pageId: string): Promise<NotionPage> {
    const page = await this.call(() => this.client.pages.retrieve({ page_id: pageId }), "read");
    return expectFull(page, isFullPage, "page");
  }

  async retrievePropertyItems(pageId: string, propertyId: string): Promise<PropertyItemObjectResponse[]> {
    const items: PropertyItemObjectResponse[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const response = await this.call(
        () => this.client.pages.properties.retrieve({ page_id: pageId, property_id: propertyId, start_cursor: cursor, page_size: 100 }),
        "read",
      );
      if (response.object !== "list") return [response];
      items.push(...response.results);
      if (!response.has_more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }
    return items;
  }

  async retrievePageMarkdown(pageId: string): Promise<PageMarkdown> {
    const response = await this.call(() => this.client.pages.retrieveMarkdown({ page_id: pageId }), "read");
    return { markdown: response.markdown, truncated: response.truncated, unknownBlockIds: response.unknown_block_ids };
  }

  async updatePageMarkdown(pageId: string, update: PageMarkdownUpdate): Promise<PageMarkdown> {
    const response = await this.call(() => this.client.pages.updateMarkdown({ page_id: pageId, ...update }), "write");
    return { markdown: response.markdown, truncated: response.truncated, unknownBlockIds: response.unknown_block_ids };
  }

  async retrieveUser(userId: string): Promise<NotionUser> {
    const user = await this.call(() => this.client.users.retrieve({ user_id: userId }), "read");
    return { id: user.id, name: user.name ?? null, type: user.type };
  }

  async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    const database = await this.call(() => this.client.databases.retrieve({ database_id: databaseId }), "read");
    return expectFull(database, isFullDatabase, "database");
  }

  async retrieveDataSource(dataSourceId: string): Promise<NotionDataSource> {
    const dataSource = await this.call(() => this.client.dataSources.retrieve({ data_source_id: dataSourceId }), "read");
    return expectFull(dataSource, isFullDataSource, "data source");
  }

  async queryDataSource(
    query: { dataSourceId: string; filter?: Record<string, unknown>; sorts?: Array<Record<string, unknown>> } & CursorQuery,
  ): Promise<Paged<NotionPage>> {
    const response = await this.call(
      () =>
        this.client.dataSources.query({
          data_source_id: query.dataSourceId,
          filter: sdkRequest<QueryDataSourceParameters["filter"]>(query.filter),
          sorts: sdkRequest<QueryDataSourceParameters["sorts"]>(query.sorts),
          page_size: query.pageSize,
          start_cursor: query.startCursor,
          result_type: "page",
        }),
      "read",
    );
    return { results: response.results.filter(isFullPage), nextCursor: response.next_cursor };
  }

  async listComments(blockId: string, query: CursorQuery): Promise<Paged<NotionComment>> {
    const response = await this.call(
      () => this.client.comments.list({ block_id: blockId, start_cursor: query.startCursor, page_size: query.pageSize }),
      "read",
    );
    return { results: response.results.filter(isFullComment), nextCursor: response.next_cursor };
  }

  async createPage(params: { parent: PageParent; properties: Record<string, unknown> }): Promise<NotionPage> {
    const page = await this.call(
      () =>
        this.client.pages.create({
          parent: params.parent,
          properties: sdkRequest<CreatePageParameters["properties"]>(params.properties),
        }),
      "write",
    );
    return expectFull(page, isFullPage, "page");
  }

  async updatePage(params: { pageId: string; properties?: Record<string, unknown>; inTrash?: boolean }): Promise<NotionPage> {
    const page = await this.call(
      () =>
        this.client.pages.update({
          page_id: params.pageId,
          properties: sdkRequest<UpdatePageParameters["properties"]>(params.properties),
          in_trash: params.inTrash,
        }),
      "write",
    );
    return expectFull(page, isFullPage, "page");
  }

  async createComment(params: { pageId: string; richText: RichTextRequest[]; displayName: string }): Promise<{ id: string }> {
    const comment = await this.call(
      () =>
        this.client.comments.create({
          parent: { page_id: params.pageId },
          rich_text: sdkRequest<Extract<CreateCommentParameters, { rich_text: unknown }>["rich_text"]>(params.richText),
          display_name: { type: "custom", custom: { name: params.displayName } },
        }),
      "write",
    );
    return { id: comment.id };
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.call(() => this.client.comments.delete({ comment_id: commentId }), "write");
  }
}
