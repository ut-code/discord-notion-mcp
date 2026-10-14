import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, runAppMigrations } from "../../src/lib/server/db/client";
import type { AnyToolDefinition, Principal } from "../../src/lib/server/mcp/registry";
import { NotionAuditStore } from "../../src/lib/server/notion/changes/audit-store";
import { NotionWriteService } from "../../src/lib/server/notion/changes/write-service";
import type { PagePropertyValue } from "../../src/lib/server/notion/content/properties";
import { createNotionTools } from "../../src/lib/server/notion/tools";
import { makeGuild, makeMember } from "../support/fakes";
import { FakeNotionApi, titleValue } from "../support/notion-fakes";

const USER = "300000000000000001";
const principal: Principal = {
  userId: "u",
  discordUserId: USER,
  clientId: "c",
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
  const writes = new NotionWriteService(api, new NotionAuditStore(database.db));
  tools = new Map(createNotionTools({ api, writes }).map((tool) => [tool.name, tool]));
});

describe("Notion tools", () => {
  test("notion_get_page renders properties and the page markdown, labeling user mentions once per user", async () => {
    const page = api.addPage({
      title: "Spec",
      markdown: [
        "# Heading",
        'Owner: <mention-user url="user://u1"/> and <mention-user url="user://u1"/>',
        'Reviewer: <mention-user url="user://u2"/>',
        'Ghost: <mention-user url="user://gone"/>',
        '<callout icon="💡">Tip</callout>',
      ].join("\n"),
    });
    api.users.set("u1", "Alice <A&B>");
    api.users.set("u2", null);

    const text = await call("notion_get_page", { page: page.url });
    expect(text).toContain("# Spec");
    expect(text).toContain("- title (title): Spec");
    expect(text).toContain("## Content\n# Heading");
    expect(text).toContain(
      'Owner: <mention-user url="user://u1">Alice &lt;A&amp;B&gt;</mention-user> and <mention-user url="user://u1">Alice &lt;A&amp;B&gt;</mention-user>',
    );
    expect(text).toContain('Reviewer: <mention-user url="user://u2"/>');
    expect(text).toContain('Ghost: <mention-user url="user://gone"/>');
    expect(text).toContain('<callout icon="💡">Tip</callout>');
    expect(text).not.toContain("truncated");
    expect(api.callsOf("retrieveUser").sort()).toEqual(["gone", "u1", "u2"]);
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

    const schema = await call("notion_get_database", { database: db.id });
    expect(schema).toContain('Database "Tasks DB"');
    expect(schema).toContain("- Status (status, id st): options: Todo, Done | groups: Complete [Done]");
    expect(schema).toContain("- Created (created_time, id ct): read-only");

    const rows = await call("notion_query_database", { database: db.id.replace(/-/g, "") });
    expect(rows).toContain('Data source "Tasks"');
    expect(rows).toContain("- Write docs (id");
    expect(rows).toContain("  - Status (status): Done");
  });

  test("notion_append_content attributes the change with the member's display name", async () => {
    const page = api.addPage({ title: "Log", markdown: "Existing" });
    const text = await call("notion_append_content", { page: page.id, content: "- one\n- two" });
    expect(text).toContain("Added content at the end of");
    expect(text).toContain("audit #1");
    expect(api.markdown.get(page.id)).toBe("Existing\n- one\n- two");
    expect(api.comments[0]!.text).toBe("🤖 Bobby (@bob, Discord) が MCP 経由で内容を追記しました — audit #1");
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
    expect(() => tools.get("notion_edit_content")!.inputSchema.parse({ page: page.id, edits: [] })).toThrow();
    expect(tools.get("notion_edit_content")!.description).toContain("exactly one place");
  });

  test("Notion 404s become a not-accessible tool error", async () => {
    await expect(call("notion_get_page", { page: "1429989fe8ac4effbc8f57f56486db54" })).rejects.toThrow(
      "not shared with the Notion integration",
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
