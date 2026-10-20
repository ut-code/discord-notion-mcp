import type { PropertyItemObjectResponse, RichTextItemResponse } from "@notionhq/client";
import {
  NO_MATCH_WARNING,
  NotionRequestError,
  type CursorQuery,
  type EditedPageMarkdown,
  type NotionApi,
  type NotionComment,
  type NotionDatabase,
  type NotionDataSource,
  type NotionPage,
  type NotionUser,
  type PageMarkdown,
  type Paged,
  type SearchResult,
} from "../../src/lib/server/notion/client/api";
import type { PageMarkdownUpdate, PageParent, RichTextRequest } from "../../src/lib/server/notion/client/types";
import { countChildObjects } from "../../src/lib/server/notion/content/enhanced-markdown";
import type { PagePropertyValue } from "../../src/lib/server/notion/content/properties";

export function rt(
  text: string,
  annotations: Partial<RichTextItemResponse["annotations"]> = {},
  href: string | null = null,
): RichTextItemResponse {
  return {
    type: "text",
    text: { content: text, link: href ? { url: href } : null },
    plain_text: text,
    href,
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default", ...annotations },
  };
}

export function titleValue(text: string, id = "title"): PagePropertyValue {
  return { id, type: "title", title: text ? [rt(text)] : [] };
}

function notFound(what: string): NotionRequestError {
  return new NotionRequestError(`Could not find ${what}.`, 404, "object_not_found");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect recorded arguments of any API method
type Call = { method: string; args: any };

let counter = 0;
function fakeId(): string {
  counter++;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

/** In-memory Notion with just enough behavior for the tools, write service and revert. */
export class FakeNotionApi implements NotionApi {
  pages = new Map<string, NotionPage>();
  /** Page content as Notion-flavored Markdown (blocks separated by a single newline). */
  markdown = new Map<string, string>();
  /** Pages whose markdown is reported as truncated, with the ids of the omitted blocks. */
  truncated = new Map<string, string[]>();
  users = new Map<string, Omit<NotionUser, "id">>();
  databases = new Map<string, NotionDatabase>();
  dataSources = new Map<string, NotionDataSource>();
  comments: Array<{ id: string; pageId: string; author: string; text: string }> = [];
  private commentSeq = 0;
  listedComments = new Map<string, NotionComment[]>();
  propertyItems = new Map<string, PropertyItemObjectResponse[]>();
  calls: Call[] = [];
  private failures = new Map<string, Error>();
  private clock = Date.parse("2026-10-12T00:00:00.000Z");

  /** Makes the next call of `method` throw `error`. */
  failNext(method: keyof NotionApi, error: Error): void {
    this.failures.set(method, error);
  }

  private enter(method: string, args: unknown): void {
    this.calls.push({ method, args });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  /** Advances the clock one minute (Notion timestamps have minute precision) and returns it. */
  tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  touch(pageId: string): void {
    const page = this.pages.get(pageId);
    if (page) page.last_edited_time = this.tick();
  }

  /** Simulates an edit made outside this server. */
  setMarkdown(pageId: string, markdown: string): void {
    this.markdown.set(pageId, markdown);
    this.touch(pageId);
  }

  callsOf(method: keyof NotionApi): Call["args"][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  addPage(options: {
    id?: string;
    title?: string;
    parent?: NotionPage["parent"];
    properties?: Record<string, PagePropertyValue>;
    markdown?: string;
  }): NotionPage {
    const id = options.id ?? fakeId();
    const now = new Date(this.clock).toISOString();
    const page = {
      object: "page",
      id,
      created_time: now,
      last_edited_time: now,
      in_trash: false,
      is_locked: false,
      url: `https://www.notion.so/page-${id.replace(/-/g, "")}`,
      public_url: null,
      parent: options.parent ?? { type: "workspace", workspace: true },
      properties: options.properties ?? { title: titleValue(options.title ?? "Untitled") },
      icon: null,
      cover: null,
      created_by: { id: "u", object: "user" },
      last_edited_by: { id: "u", object: "user" },
    } as unknown as NotionPage;
    this.pages.set(id, page);
    this.markdown.set(id, options.markdown ?? "");
    return page;
  }

  addDataSource(options: { id?: string; title: string; databaseId: string; properties: Record<string, unknown> }): NotionDataSource {
    const id = options.id ?? fakeId();
    const dataSource = {
      object: "data_source",
      id,
      title: [rt(options.title)],
      description: [],
      parent: { type: "database_id", database_id: options.databaseId },
      database_parent: { type: "workspace", workspace: true },
      is_inline: false,
      in_trash: false,
      created_time: "2026-10-12T00:00:00.000Z",
      last_edited_time: "2026-10-12T00:00:00.000Z",
      properties: options.properties,
      url: `https://www.notion.so/ds-${id.replace(/-/g, "")}`,
    } as unknown as NotionDataSource;
    this.dataSources.set(id, dataSource);
    return dataSource;
  }

  addDatabase(options: { id?: string; title: string; dataSources: Array<{ id: string; name: string }> }): NotionDatabase {
    const id = options.id ?? fakeId();
    const database = {
      object: "database",
      id,
      title: [rt(options.title)],
      description: [],
      parent: { type: "workspace", workspace: true },
      is_inline: false,
      in_trash: false,
      data_sources: options.dataSources,
      url: `https://www.notion.so/db-${id.replace(/-/g, "")}`,
    } as unknown as NotionDatabase;
    this.databases.set(id, database);
    return database;
  }

  async search(query: { query: string; filter?: "page" | "data_source" } & CursorQuery): Promise<Paged<SearchResult>> {
    this.enter("search", query);
    const pages = [...this.pages.values()].filter((page) => !page.in_trash);
    const all: SearchResult[] = [
      ...(query.filter === "data_source" ? [] : pages),
      ...(query.filter === "page" ? [] : [...this.dataSources.values()]),
    ];
    const matches = all.filter((item) => {
      const title =
        item.object === "page"
          ? Object.values(item.properties).find((value) => value.type === "title")
          : { type: "title", title: item.title };
      const text = title && "title" in title ? title.title.map((t) => t.plain_text).join("") : "";
      return text.toLowerCase().includes(query.query.toLowerCase());
    });
    return { results: matches.slice(0, query.pageSize), nextCursor: null };
  }

  async retrievePage(pageId: string): Promise<NotionPage> {
    this.enter("retrievePage", pageId);
    const page = this.pages.get(pageId);
    if (!page) throw notFound("page");
    return structuredClone(page);
  }

  async retrievePropertyItems(pageId: string, propertyId: string): Promise<PropertyItemObjectResponse[]> {
    this.enter("retrievePropertyItems", { pageId, propertyId });
    return this.propertyItems.get(`${pageId}:${propertyId}`) ?? [];
  }

  private pageMarkdown(pageId: string): PageMarkdown {
    const markdown = this.markdown.get(pageId) ?? "";
    const omitted = this.truncated.get(pageId);
    return { markdown, truncated: omitted !== undefined, unknownBlockIds: omitted ?? [] };
  }

  async retrievePageMarkdown(pageId: string): Promise<PageMarkdown> {
    this.enter("retrievePageMarkdown", pageId);
    if (!this.pages.has(pageId)) throw notFound("page");
    return this.pageMarkdown(pageId);
  }

  /**
   * As Notion does it (checked live): update_content applies its edits in order by exact substring,
   * fails as a whole when an old_str matches several places or every edit misses, and otherwise
   * applies the edits that match and warns of each miss. replace_content refuses to drop a child
   * page or database.
   */
  async updatePageMarkdown(pageId: string, update: PageMarkdownUpdate): Promise<EditedPageMarkdown> {
    this.enter("updatePageMarkdown", { pageId, update: structuredClone(update) });
    if (!this.pages.has(pageId)) throw notFound("page");
    const body =
      update.type === "update_content"
        ? update.update_content
        : update.type === "insert_content"
          ? update.insert_content
          : update.replace_content;
    if ("allow_deleting_content" in body) throw new Error("allow_deleting_content must never be sent");
    const current = this.markdown.get(pageId) ?? "";
    let next = current;
    const warnings: EditedPageMarkdown["warnings"] = [];
    switch (update.type) {
      case "update_content": {
        const missed: string[] = [];
        for (const { old_str, new_str } of update.update_content.content_updates) {
          const at = next.indexOf(old_str);
          if (at === -1) {
            missed.push(old_str);
            continue;
          }
          if (next.indexOf(old_str, at + 1) !== -1) {
            throw new NotionRequestError(`Multiple matches found for "${old_str}".`, 400, "validation_error");
          }
          next = next.slice(0, at) + new_str + next.slice(at + old_str.length);
        }
        if (missed.length === update.update_content.content_updates.length) {
          throw new NotionRequestError(`No matches found for ${missed.length} content updates.`, 400, "validation_error");
        }
        warnings.push(...missed.map((old_str) => ({ code: NO_MATCH_WARNING, message: `No matches found for ${old_str}.` })));
        break;
      }
      case "insert_content": {
        const { content, position } = update.insert_content;
        if (!current) next = content;
        else next = position.type === "start" ? `${content}\n${current}` : `${current}\n${content}`;
        break;
      }
      case "replace_content":
        if (countChildObjects(update.replace_content.new_str) < countChildObjects(current)) {
          throw new NotionRequestError("This operation would delete child pages or databases.", 400, "validation_error");
        }
        next = update.replace_content.new_str;
        break;
      default:
        throw new Error(`Unknown markdown update: ${update satisfies never}`);
    }
    this.markdown.set(pageId, next);
    this.touch(pageId);
    return { ...this.pageMarkdown(pageId), warnings };
  }

  async retrieveUser(userId: string): Promise<NotionUser> {
    this.enter("retrieveUser", userId);
    const user = this.users.get(userId);
    if (!user) throw notFound("user");
    return { id: userId, ...user };
  }

  async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    this.enter("retrieveDatabase", databaseId);
    const database = this.databases.get(databaseId);
    if (!database) throw notFound("database");
    return database;
  }

  async retrieveDataSource(dataSourceId: string): Promise<NotionDataSource> {
    this.enter("retrieveDataSource", dataSourceId);
    const dataSource = this.dataSources.get(dataSourceId);
    if (!dataSource) throw notFound("data source");
    return dataSource;
  }

  async queryDataSource(
    query: { dataSourceId: string; filter?: Record<string, unknown>; sorts?: Array<Record<string, unknown>> } & CursorQuery,
  ): Promise<Paged<NotionPage>> {
    this.enter("queryDataSource", query);
    const rows = [...this.pages.values()].filter(
      (page) => page.parent.type === "data_source_id" && page.parent.data_source_id === query.dataSourceId,
    );
    return { results: rows.slice(0, query.pageSize), nextCursor: null };
  }

  async listComments(blockId: string, query: CursorQuery): Promise<Paged<NotionComment>> {
    this.enter("listComments", { blockId, ...query });
    const all = this.listedComments.get(blockId) ?? [];
    const start = query.startCursor ? Number(query.startCursor) : 0;
    const end = start + query.pageSize;
    return { results: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
  }

  async createPage(params: { parent: PageParent; properties: Record<string, unknown> }): Promise<NotionPage> {
    this.enter("createPage", params);
    const titleEntry = Object.entries(params.properties).find(([, value]) => "title" in (value as object));
    const title = titleEntry
      ? (titleEntry[1] as { title: RichTextRequest[] }).title.map((t) => ("text" in t ? t.text.content : "")).join("")
      : "";
    const parent =
      params.parent.type === "page_id"
        ? { type: "page_id", page_id: params.parent.page_id }
        : { type: "data_source_id", data_source_id: params.parent.data_source_id, database_id: "db" };
    const page = this.addPage({
      title,
      parent: parent as NotionPage["parent"],
      properties: { [titleEntry?.[0] ?? "title"]: titleValue(title) },
    });
    page.last_edited_time = this.tick();
    return structuredClone(page);
  }

  async updatePage(params: { pageId: string; properties?: Record<string, unknown>; inTrash?: boolean }): Promise<NotionPage> {
    this.enter("updatePage", params);
    const page = this.pages.get(params.pageId);
    if (!page) throw notFound("page");
    for (const [key, value] of Object.entries(params.properties ?? {})) {
      const entry = Object.entries(page.properties).find(([name, current]) => name === key || current.id === key);
      const name = entry?.[0] ?? key;
      const type = Object.keys(value as object)[0]!;
      page.properties[name] = { id: entry?.[1].id ?? key, type, ...(value as object) } as PagePropertyValue;
    }
    if (params.inTrash !== undefined) page.in_trash = params.inTrash;
    page.last_edited_time = this.tick();
    return structuredClone(page);
  }

  async createComment(params: { pageId: string; richText: RichTextRequest[]; displayName: string }): Promise<{ id: string }> {
    this.enter("createComment", params);
    const id = `comment-${++this.commentSeq}`;
    const text = params.richText.map((t) => ("text" in t ? t.text.content : "")).join("");
    this.comments.push({ id, pageId: params.pageId, author: params.displayName, text });
    return { id };
  }

  async deleteComment(commentId: string): Promise<void> {
    this.enter("deleteComment", commentId);
    const index = this.comments.findIndex((comment) => comment.id === commentId);
    if (index === -1) throw notFound("comment");
    this.comments.splice(index, 1);
  }
}
