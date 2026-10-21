import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, runAppMigrations } from "../../src/lib/server/db/client";
import type { AnyToolDefinition, Principal } from "../../src/lib/server/mcp/registry";
import { NotionAuditStore } from "../../src/lib/server/notion/changes/audit-store";
import { NotionWriteService } from "../../src/lib/server/notion/changes/write-service";
import type { PagePropertyValue } from "../../src/lib/server/notion/content/properties";
import { createNotionTools } from "../../src/lib/server/notion/tools";
import { makeGuild, makeMember } from "../../src/lib/server/fakes/discord";
import type { NotionComment } from "../../src/lib/server/notion/client/api";
import { NotionRequestError } from "../../src/lib/server/notion/client/api";
import { FakeNotionApi, titleValue } from "../../src/lib/server/fakes/notion";

const USER = "300000000000000001";
const principal: Principal = {
  userId: "u",
  discordUserId: USER,
  access: {
    isMember: true,
    discordUserId: USER,
    guild: makeGuild(),
    member: { ...makeMember(USER), username: "bob", globalName: "Bobby" },
    permissions: new Set(["notion:read", "notion:write"]),
    isAdmin: false,
  },
};

let api: FakeNotionApi;
let tools: Map<string, AnyToolDefinition>;

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name)!;
  const result = await tool.handler(tool.inputSchema.parse(args), { principal });
  return typeof result === "string" ? result : JSON.stringify(result);
}

beforeEach(() => {
  const database = openDatabase(":memory:");
  runAppMigrations(database.db);
  api = new FakeNotionApi();
  const writes = new NotionWriteService(
    api,
    new NotionAuditStore(database.db),
    () => {},
    async () => {},
  );
  tools = new Map(createNotionTools({ api, writes }).map((tool) => [tool.name, tool]));
});

describe("Notion tools", () => {
  test("notion_get_page renders properties and the page markdown verbatim", async () => {
    const markdown = ["# Heading", 'Owner: <mention-user url="user://u1"/>', '<callout icon="💡">Tip</callout>'].join("\n");
    const page = api.addPage({ title: "Spec", markdown });
    const text = await call("notion_get_page", { page: page.url });
    expect(text).toContain("# Spec");
    expect(text).toContain("- title (title): Spec");
    expect(text.endsWith(`## Content\n${markdown}`)).toBe(true);
    expect(api.callsOf("retrieveUser")).toEqual([]);
  });

  test("notion_get_users names each user once, in order, and says why one could not be named", async () => {
    const alice = "00000000-0000-4000-8000-0000000000a1";
    const bot = "00000000-0000-4000-8000-0000000000b1";
    const nameless = "00000000-0000-4000-8000-0000000000a2";
    const gone = "00000000-0000-4000-8000-0000000000a3";
    api.users.set(alice, { name: "Alice\nSmith", type: "person" });
    api.users.set(bot, { name: "Sync", type: "bot" });
    api.users.set(nameless, { name: null, type: "person" });
    api.failNext("retrieveUser", new NotionRequestError("rate limited", 429, "rate_limited"));
    const text = await call("notion_get_users", {
      user_ids: [`user://${alice}`, alice.replace(/-/g, ""), bot, nameless, gone],
    });
    expect(text.split("\n")).toEqual([
      `- user://${alice}: lookup failed (HTTP 429); retry later`,
      `- user://${bot}: Sync (bot)`,
      `- user://${nameless}: (no name) (person)`,
      `- user://${gone}: not found or not accessible`,
    ]);
    expect(await call("notion_get_users", { user_ids: [alice] })).toBe(`- user://${alice}: Alice Smith (person)`);
    for (const input of ["user://alice", `https://www.notion.so/page-${alice.replace(/-/g, "")}`]) {
      await expect(call("notion_get_users", { user_ids: [input] })).rejects.toThrow('Invalid "user_ids[0]": expected a user id');
    }
  });

  test("notion_get_page puts each property on one line, quickly even for long runs of spaces", async () => {
    const page = api.addPage({
      properties: { title: titleValue("Spec"), Notes: titleValue(`first\n  second${" ".repeat(200_000)}end`, "notes") },
    });
    const text = await call("notion_get_page", { page: page.url });
    expect(text).toContain("- Notes (title): first second end");
  });

  test("notion_get_page reports truncated content and the omitted blocks", async () => {
    const page = api.addPage({ title: "Big", markdown: "Start" });
    api.truncated.set(page.id, ["b1", "b2"]);
    const text = await call("notion_get_page", { page: page.id });
    expect(text).toContain("truncated");
    expect(text).toContain("b1, b2");
    const empty = api.addPage({ title: "Empty" });
    expect(await call("notion_get_page", { page: empty.id })).toContain("## Content\n(empty)");
  });

  test("notion_get_page no longer accepts block-tree limits and describes the markdown syntax", () => {
    const tool = tools.get("notion_get_page")!;
    expect(Object.keys((tool.inputSchema as { shape: object }).shape)).toEqual(["page"]);
    expect(tool.description).toContain("<details>");
    expect(tool.description).toContain("<mention-user");
  });

  test("notion_get_comments lists comments page by page, up to 300", async () => {
    const PAGE_ID = "00000000-0000-4000-8000-0000000000c1";
    const comment = (index: number) =>
      ({
        id: `comment-${index}`,
        created_time: "2026-10-16T00:00:00.000Z",
        created_by: { id: "notion-user", object: "user" },
        rich_text: [{ type: "text", plain_text: `comment ${index}`, text: { content: `comment ${index}` } }],
      }) as unknown as NotionComment;
    api.listedComments.set(
      PAGE_ID,
      Array.from({ length: 350 }, (_, index) => comment(index)),
    );
    const text = await call("notion_get_comments", { target: PAGE_ID });
    expect(text.split("\n")[0]).toBe("300 comment(s):");
    expect(text).toContain("comment 299");
    expect(text).not.toContain("comment 300");
    expect(text).toContain("(More comments exist; only the first 300 are shown.)");
    expect(api.callsOf("listComments")).toHaveLength(3);

    // Notion may return fewer comments than asked for; the last page asks only for what is left.
    const list = api.listComments.bind(api);
    api.listComments = async (blockId, query) => list(blockId, { ...query, pageSize: Math.min(query.pageSize, 90) });
    const short = await call("notion_get_comments", { target: PAGE_ID });
    expect(short.split("\n")[0]).toBe("300 comment(s):");
    expect(short).toContain("(More comments exist; only the first 300 are shown.)");
    api.listComments = list;

    api.listedComments.set(PAGE_ID, [comment(0)]);
    expect(await call("notion_get_comments", { target: PAGE_ID })).not.toContain("More comments exist");
  });

  test("notion_get_database and notion_query_database", async () => {
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: {
        Name: { id: "title", name: "Name", type: "title", title: {} },
        Status: {
          id: "st",
          name: "Status",
          type: "status",
          status: {
            options: [
              { id: "a", name: "Todo" },
              { id: "b", name: "Done" },
            ],
            groups: [{ name: "Complete", option_ids: ["b"] }],
          },
        },
        Created: { id: "ct", name: "Created", type: "created_time", created_time: {} },
      },
    });
    const db = api.addDatabase({ title: "Tasks DB", dataSources: [{ id: ds.id, name: "Tasks" }] });
    api.addPage({
      parent: { type: "data_source_id", data_source_id: ds.id, database_id: db.id } as never,
      properties: {
        Name: titleValue("Write docs"),
        Status: { id: "st", type: "status", status: { id: "b", name: "Done", color: "green" } } as PagePropertyValue,
      },
    });

    api.templates.set(ds.id, [
      { id: "11111111-1111-4111-8111-111111111111", name: "Weekly", isDefault: true },
      { id: "22222222-2222-4222-8222-222222222222", name: "", isDefault: false },
    ]);
    const schema = await call("notion_get_database", { database: db.id });
    expect(schema).toContain("Templates (template_id of notion_create_page):");
    expect(schema).toContain("- Weekly (id 11111111-1111-4111-8111-111111111111) — default");
    expect(schema).toContain("- Untitled (id 22222222-2222-4222-8222-222222222222)");
    api.failNext("listTemplates", new NotionRequestError("Insufficient permissions.", 403, "restricted_resource"));
    expect(await call("notion_get_database", { database: db.id })).toContain("Templates: (could not be listed)");
    const listTemplates = api.listTemplates.bind(api);
    api.listTemplates = async (id) => ({ ...(await listTemplates(id)), more: true });
    expect(await call("notion_get_database", { database: db.id })).toContain("- (more templates exist; only the first 100 are listed)");
    api.listTemplates = listTemplates;
    expect(schema).toContain('Database "Tasks DB"');
    expect(schema).toContain("- Status (status, id st): options: Todo, Done | groups: Complete [Done]");
    expect(schema).toContain("- Created (created_time, id ct): read-only");

    const rows = await call("notion_query_database", { database: db.id.replace(/-/g, "") });
    expect(rows).toContain('Data source "Tasks"');
    expect(rows).toContain("- Write docs (id");
    expect(rows).toContain("  - Status (status): Done");
  });

  test("notion_create_page fills a database row from a template in Japan time, waiting for its body", async () => {
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    const weekly = api.addPage({ title: "Weekly", markdown: "## Agenda" });
    api.templates.set(ds.id, [{ id: weekly.id, name: "Weekly", isDefault: true }]);

    const text = await call("notion_create_page", { parent: ds.id, title: "Week 42", template_id: weekly.id });
    expect(text).not.toContain("Warning");
    const created = api.callsOf("createPage")[0];
    expect(created).toMatchObject({ template: { type: "template_id", template_id: weekly.id, timezone: "Asia/Tokyo" } });
    expect(api.markdown.get([...api.pages.keys()].at(-1)!)).toBe("## Agenda");

    // A body that never arrives is reported.
    api.templateDelayReads = Number.POSITIVE_INFINITY;
    expect(await call("notion_create_page", { parent: ds.id, title: "Week 43", template_id: weekly.id })).toContain(
      "Notion had not finished filling in the template",
    );
  });

  test("notion_create_page refuses a template with content, under a page, or that is not an id", async () => {
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    const template = api.addPage({ title: "Weekly", markdown: "## Agenda" });
    await expect(call("notion_create_page", { parent: ds.id, title: "x", template_id: template.id, content: "body" })).rejects.toThrow(
      "A template fills in the page body itself",
    );
    const page = api.addPage({ title: "Parent" });
    await expect(call("notion_create_page", { parent: page.id, title: "x", template_id: template.id })).rejects.toThrow(
      "Templates belong to databases",
    );
    await expect(call("notion_create_page", { parent: ds.id, title: "x", template_id: "default" })).rejects.toThrow(
      'Invalid "template_id"',
    );
    expect(api.callsOf("createPage")).toHaveLength(0);
  });

  test("notion_append_content attributes the change with the member's display name", async () => {
    const page = api.addPage({ title: "Log", markdown: "Existing" });
    const text = await call("notion_append_content", { page: page.id, content: "- one\n- two" });
    expect(text).toContain("Added content at the end of");
    expect(text).toContain("audit #1");
    expect(api.markdown.get(page.id)).toBe("Existing\n- one\n- two");
    expect(api.comments[0]).toMatchObject({ author: "Bobby (@bob, Discord)", text: "🤖 MCP 経由で内容を追記しました — audit #1" });
  });

  test("notion_edit_content applies edits and surfaces Notion validation errors", async () => {
    const page = api.addPage({ title: "Doc", markdown: "Anchor A.\nAnchor B." });
    const text = await call("notion_edit_content", {
      page: page.url,
      edits: [{ old_str: "Anchor A.", new_str: "Anchor A.\n\nInserted paragraph." }],
    });
    expect(text).toContain("Applied 1 edit(s)");
    expect(api.markdown.get(page.id)).toBe("Anchor A.\n\nInserted paragraph.\nAnchor B.");
    expect(api.comments.at(-1)!.text).toContain("本文を編集しました");

    await expect(call("notion_edit_content", { page: page.id, edits: [{ old_str: "Nope", new_str: "x" }] })).rejects.toThrow(
      "No matches found",
    );
    await expect(call("notion_edit_content", { page: page.id, edits: [{ old_str: "Anchor", new_str: "x" }] })).rejects.toThrow(
      "Multiple matches found",
    );
    await expect(
      call("notion_edit_content", { page: page.id, edits: [{ old_str: "Anchor B.", new_str: '<page url="">Sub</page>' }] }),
    ).rejects.toThrow("notion_create_page");
    const partial = await call("notion_edit_content", {
      page: page.id,
      edits: [
        { old_str: "Anchor B.", new_str: "Anchor B, edited." },
        { old_str: "Gone", new_str: "x" },
      ],
    });
    expect(partial).toContain("Applied 1 of 2 edit(s)");
    expect(partial).toContain(
      "Not applied, as Notion found no match (retry only these, with old_str copied from notion_get_page): No matches found for Gone.",
    );
    expect(api.markdown.get(page.id)).toBe("Anchor A.\n\nInserted paragraph.\nAnchor B, edited.");
    expect(() => tools.get("notion_edit_content")!.inputSchema.parse({ page: page.id, edits: [] })).toThrow();
    expect(tools.get("notion_edit_content")!.description).toContain("exactly one place");
  });

  test("Notion 404s become a not-accessible tool error", async () => {
    await expect(call("notion_get_page", { page: "1429989fe8ac4effbc8f57f56486db54" })).rejects.toThrow(
      "not shared with the Notion integration",
    );
  });

  test("a Notion outage becomes a retry-later tool error", async () => {
    const page = api.addPage({ title: "Doc" });
    api.failNext("retrievePage", new NotionRequestError("Service Unavailable", 503, "service_unavailable"));
    await expect(call("notion_get_page", { page: page.id })).rejects.toThrow(
      "Notion is not responding (HTTP 503); please retry in a moment.",
    );
  });

  test("property values larger than 100,000 characters of JSON are rejected", () => {
    const schema = tools.get("notion_update_properties")!.inputSchema;
    const text = (length: number) => ({ Notes: { rich_text: [{ text: { content: "x".repeat(length) } }] } });
    const overhead = JSON.stringify(text(0)).length;
    expect(schema.safeParse({ page: "p", properties: text(100_000 - overhead) }).success).toBe(true);
    const rejected = schema.safeParse({ page: "p", properties: text(100_001 - overhead) });
    expect(rejected.success).toBe(false);
    expect(rejected.error!.issues[0]!.message).toBe("Property values are too large (at most 100000 characters as JSON).");
    expect(tools.get("notion_create_page")!.inputSchema.safeParse({ parent: "p", title: "t", properties: text(200_000) }).success).toBe(
      false,
    );
  });
});
