import { ToolError } from "../../lib/errors";
import {
  isNotionMiss,
  isNotionUnavailable,
  notionFailure,
  NotionRequestError,
  type NotionApi,
  type NotionDatabase,
  type NotionDataSource,
  type NotionPage,
} from "./api";
import { plainText } from "../content/rich-text";

const NOTION_NOT_ACCESSIBLE_MESSAGE =
  "Not found, or not shared with the Notion integration (an admin must connect the integration to the page or a parent page).";

class NotionNotAccessibleError extends ToolError {
  constructor(message = NOTION_NOT_ACCESSIBLE_MESSAGE) {
    super(message);
  }
}

/** Maps Notion API errors to tool errors whose message is safe to show to the caller. */
export function toToolError(error: unknown): unknown {
  if (!(error instanceof NotionRequestError)) return error;
  if (error.status === 404 || error.status === 403) return new NotionNotAccessibleError();
  if (error.status === 400 || error.status === 409) {
    // Notion's message may quote page text (an old_str it did not find), so logs keep its code only.
    return new ToolError(`Notion rejected the request: ${error.message}`, {
      logMessage: `Notion rejected the request (${error.status} ${error.code})`,
    });
  }
  if (error.status === 429) {
    const wait = error.retryAfterMs === undefined ? "in a moment" : `in about ${Math.ceil(error.retryAfterMs / 1000)} s`;
    return new ToolError(`Notion rate limit reached; retry ${wait}.`);
  }
  if (isNotionUnavailable(error)) return new ToolError(`Notion is not responding (${notionFailure(error)}); please retry in a moment.`);
  return error;
}

export function dataSourceTitle(dataSource: Pick<NotionDataSource, "title">): string {
  return plainText(dataSource.title) || "Untitled";
}

export interface ResolvedDataSource {
  dataSource: NotionDataSource;
  /** Set when the caller passed a database id. */
  database: NotionDatabase | null;
}

function multipleDataSourcesError(database: NotionDatabase): ToolError {
  const options = database.data_sources.map((ds) => `- ${ds.name || "Untitled"} (data source id ${ds.id})`).join("\n");
  return new ToolError(
    `Database "${plainText(database.title) || database.id}" has ${database.data_sources.length} data sources. Call again with one of these data source ids:\n${options}`,
  );
}

/**
 * Accepts a data source id or a database id. A database with exactly one data
 * source resolves to it transparently; with several, the caller must pick one.
 */
export async function resolveDataSource(api: NotionApi, id: string): Promise<ResolvedDataSource> {
  try {
    return { dataSource: await api.retrieveDataSource(id), database: null };
  } catch (error) {
    if (!isNotionMiss(error)) throw error;
  }
  let database: NotionDatabase;
  try {
    database = await api.retrieveDatabase(id);
  } catch (error) {
    if (isNotionMiss(error)) throw new NotionNotAccessibleError();
    throw error;
  }
  const [dataSource, ...others] = database.data_sources;
  if (!dataSource) throw new ToolError("This database has no data sources.");
  if (others.length > 0) throw multipleDataSourcesError(database);
  return { dataSource: await api.retrieveDataSource(dataSource.id), database };
}

export interface DatabaseView {
  database: NotionDatabase | null;
  dataSources: NotionDataSource[];
}

/** For schema display: a database with all its data sources, or a single data source. */
export async function resolveDatabaseView(api: NotionApi, id: string): Promise<DatabaseView> {
  try {
    const database = await api.retrieveDatabase(id);
    const dataSources = await Promise.all(database.data_sources.map((ds) => api.retrieveDataSource(ds.id)));
    return { database, dataSources };
  } catch (error) {
    if (!isNotionMiss(error)) throw error;
  }
  try {
    return { database: null, dataSources: [await api.retrieveDataSource(id)] };
  } catch (error) {
    if (isNotionMiss(error)) throw new NotionNotAccessibleError();
    throw error;
  }
}

export type ResolvedParent = { kind: "page"; page: NotionPage } | ({ kind: "data_source" } & ResolvedDataSource);

/** A create_page parent: a page, or a database / data source. */
export async function resolveParent(api: NotionApi, id: string): Promise<ResolvedParent> {
  try {
    return { kind: "page", page: await api.retrievePage(id) };
  } catch (error) {
    if (!isNotionMiss(error)) throw error;
  }
  return { kind: "data_source", ...(await resolveDataSource(api, id)) };
}
