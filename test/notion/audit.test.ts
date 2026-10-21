import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, runAppMigrations, type AppDatabase } from "../../src/lib/server/db/client";
import { ToolError } from "../../src/lib/server/lib/errors";
import type { EventEntry } from "../../src/lib/server/lib/log";
import { NotionRequestError, type NotionPage } from "../../src/lib/server/notion/client/api";
import type { Actor } from "../../src/lib/server/notion/changes/attribution";
import { NotionAuditService, startInterruptedWriteSweep } from "../../src/lib/server/notion/changes/audit-service";
import { NotionAuditStore } from "../../src/lib/server/notion/changes/audit-store";
import type { RevertNote, WriteWarning } from "../../src/lib/server/notion/changes/audit-records";
import { revertReasonText, revertSuccessText, writeWarningText } from "../../src/lib/server/notion/changes/outcome-text";
import type { RevertResult } from "../../src/lib/server/notion/changes/revert-reasons";
import { NotionWriteService } from "../../src/lib/server/notion/changes/write-service";
import { sha256 } from "../../src/lib/server/notion/content/content-diff";
import type { PagePropertyValue } from "../../src/lib/server/notion/content/properties";
import { insertAuditRow, overwriteAuditRow } from "../support/audit-rows";
import { FakeNotionApi, titleValue } from "../../src/lib/server/fakes/notion";

const ACTOR: Actor = { discordUserId: "300000000000000001", displayName: "Alice", username: "alice" };
const ADMIN = { actorDiscordUserId: "300000000000000009", actorDisplayName: "Admin" };

let api: FakeNotionApi;
let db: AppDatabase;
let store: NotionAuditStore;
let writes: NotionWriteService;
let audit: NotionAuditService;
let parent: NotionPage;

beforeEach(() => {
  const database = openDatabase(":memory:");
  runAppMigrations(database.db);
  api = new FakeNotionApi();
  db = database.db;
  store = new NotionAuditStore(database.db);
  writes = new NotionWriteService(api, store);
  audit = new NotionAuditService(store, api);
  parent = api.addPage({ title: "Parent" });
});

function addRow(properties: Record<string, PagePropertyValue> = {}): NotionPage {
  const ds = api.addDataSource({
    title: "Tasks",
    databaseId: "db",
    properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
  });
  return api.addPage({
    parent: { type: "data_source_id", data_source_id: ds.id, database_id: "db" } as never,
    properties: { Name: titleValue("Row"), ...properties },
  });
}

describe("NotionWriteService", () => {
  test("every write is recorded as pending before Notion is touched", async () => {
    const statusesSeen: string[] = [];
    const seen = async () => {
      const { rows } = await store.list({ limit: 1, offset: 0 });
      statusesSeen.push(rows[0]?.status ?? "none");
    };
    const wrap = <K extends "createPage" | "updatePageMarkdown" | "updatePage">(method: K) => {
      const original = api[method].bind(api) as (...args: unknown[]) => Promise<unknown>;
      Object.assign(api, { [method]: async (...args: unknown[]) => (await seen(), original(...args)) });
    };
    wrap("createPage");
    wrap("updatePageMarkdown");
    wrap("updatePage");
    const row = addRow({ Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue });

    await writes.createPage(ACTOR, { parentId: parent.id, title: "P", request: {} });
    await writes.appendContent(ACTOR, { pageId: parent.id, content: "a", request: {} });
    await writes.updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: 2 } }, request: {} });
    expect(statusesSeen).toEqual(["pending", "pending", "pending"]);
    expect((await store.list({ limit: 10, offset: 0 })).rows.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
  });

  test("a crash between the Notion write and its outcome leaves an interrupted row", async () => {
    api.updatePageMarkdown = () => new Promise(() => {});
    void writes.appendContent(ACTOR, { pageId: parent.id, content: "lost", request: {} });
    await Bun.sleep(10);
    const [pending] = (await store.list({ limit: 1, offset: 0 })).rows;
    expect(pending).toMatchObject({ status: "pending", operation: "append_content", targetPageId: parent.id });
    expect(await audit.markInterruptedWrites(new Date(Date.now() + 11 * 60_000))).toBe(1);
    expect(audit.revertability((await store.get(pending!.id))!)).toEqual({ kind: "not_ok", status: "interrupted" });
  });

  test("a write that ends after being marked interrupted is recorded with its content after all", async () => {
    api.markdown.set(parent.id, "Body");
    const write = api.updatePageMarkdown.bind(api);
    let finish = () => {};
    api.updatePageMarkdown = (pageId, update) => new Promise((resolve) => (finish = () => resolve(write(pageId, update))));
    const outcome = writes.appendContent(ACTOR, { pageId: parent.id, content: "late", request: {} });
    await Bun.sleep(10);
    expect(await audit.markInterruptedWrites(new Date(Date.now() + 11 * 60_000))).toBe(1);
    finish();
    const { auditId } = await outcome;
    expect(await store.get(auditId)).toMatchObject({ status: "ok" });
    expect(await store.getContent(auditId)).toEqual({ before: "Body", after: "Body\nlate" });
  });

  test("warnings Notion returns that this server does not know are logged by code only", async () => {
    const logged: unknown[] = [];
    const logging = new NotionWriteService(api, store, (entry) => logged.push(entry));
    const write = api.updatePageMarkdown.bind(api);
    api.updatePageMarkdown = async (pageId, update) => ({
      ...(await write(pageId, update)),
      warnings: [{ code: "something_new", message: "quotes page text" }],
    });
    await logging.appendContent(ACTOR, { pageId: parent.id, content: "x", request: {} });
    expect(logged).toEqual([{ event: "notion_unknown_warning", pageId: parent.id, code: "something_new" }]);
  });

  test("a row made from a template waits for its body, keeps it, and reverts without it counting as a later edit", async () => {
    const sleeps: number[] = [];
    const waiting = new NotionWriteService(
      api,
      store,
      () => {},
      async (ms) => void sleeps.push(ms),
    );
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    const template = api.addPage({ title: "Weekly", markdown: "## Agenda" });
    api.templates.set(ds.id, [{ id: template.id, name: "Weekly", isDefault: true }]);
    const outcome = await waiting.createPage(ACTOR, { parentId: ds.id, title: "Week", templateId: template.id, request: {} });
    // Filled in on the second read, and taken as done once the third read agrees.
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(outcome.warning).toBeNull();
    expect(await store.getContent(outcome.auditId)).toEqual({ before: "", after: "## Agenda" });
    expect(await audit.revert(outcome.auditId, ADMIN)).toMatchObject({ ok: true });
  });

  test("a created page read back truncated is not kept as what it holds, and its revert is flagged", async () => {
    const existing = new Set(api.pages.keys());
    // The new page renders truncated from the first read on.
    const waiting = new NotionWriteService(
      api,
      store,
      () => {},
      async () => {
        for (const id of api.pages.keys()) if (!existing.has(id)) api.truncated.set(id, ["omitted"]);
      },
    );
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    const template = api.addPage({ title: "Weekly", markdown: "## Agenda" });
    existing.add(ds.id).add(template.id);
    api.templates.set(ds.id, [{ id: template.id, name: "Weekly", isDefault: true }]);
    const truncated: WriteWarning = { kind: "revert_blocked", blocker: "truncated_after_write" };
    const outcome = await waiting.createPage(ACTOR, { parentId: ds.id, title: "Week", templateId: template.id, request: {} });
    expect(outcome.warning).toEqual(truncated);
    expect(await store.getContent(outcome.auditId)).toBeNull();

    const write = api.updatePageMarkdown.bind(api);
    api.updatePageMarkdown = async (pageId, update) => ({ ...(await write(pageId, update)), truncated: true });
    const written = await writes.createPage(ACTOR, { parentId: parent.id, title: "Long", content: "Body", request: {} });
    expect(written.warning).toEqual(truncated);
    expect((await store.get(written.auditId))!.note).toEqual(truncated);
    expect(await store.getContent(written.auditId)).toBeNull();
  });

  test("a template without a body is not waited for, and one that never arrives is recorded as pending", async () => {
    const sleeps: number[] = [];
    const waiting = new NotionWriteService(
      api,
      store,
      () => {},
      async (ms) => void sleeps.push(ms),
    );
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    const bare = api.addPage({ title: "Bare" });
    const weekly = api.addPage({ title: "Weekly", markdown: "## Agenda" });
    api.templates.set(ds.id, [
      { id: bare.id, name: "Bare", isDefault: false },
      { id: weekly.id, name: "Weekly", isDefault: true },
    ]);
    const plain = await waiting.createPage(ACTOR, { parentId: ds.id, title: "A", templateId: bare.id, request: {} });
    expect(sleeps).toEqual([]);
    expect(plain.warning).toBeNull();
    expect(await store.getContent(plain.auditId)).toBeNull();

    api.templateDelayReads = Number.POSITIVE_INFINITY;
    const pending = await waiting.createPage(ACTOR, { parentId: ds.id, title: "B", templateId: weekly.id, request: {} });
    expect(sleeps).toHaveLength(10);
    expect(pending.warning).toEqual({ kind: "template_pending" });
    expect((await store.get(pending.auditId))!.note).toEqual({ kind: "template_pending" });

    // As the warning says: when the template arrives later, the revert sees it as a later edit.
    api.setMarkdown(pending.pageId, "## Agenda");
    expect(await audit.revert(pending.auditId, ADMIN)).toMatchObject({
      ok: false,
      reason: { kind: "conflict", conflict: { kind: "edited_after" } },
    });
  });

  test("a template that arrives over several reads is recorded once complete", async () => {
    const quick = new NotionWriteService(
      api,
      store,
      () => {},
      () => Promise.resolve(),
    );
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    const template = api.addPage({ title: "Weekly", markdown: "## Agenda\n- a\n## Notes\n- b" });
    api.templates.set(ds.id, [{ id: template.id, name: "Weekly", isDefault: true }]);
    api.templateFillReads = 2;
    const outcome = await quick.createPage(ACTOR, { parentId: ds.id, title: "Week", templateId: template.id, request: {} });
    expect(outcome.warning).toBeNull();
    expect(await store.getContent(outcome.auditId)).toEqual({ before: "", after: "## Agenda\n- a\n## Notes\n- b" });
  });

  test("a template that cannot be read is waited for as if it had a body", async () => {
    const sleeps: number[] = [];
    const waiting = new NotionWriteService(
      api,
      store,
      () => {},
      async (ms) => void sleeps.push(ms),
    );
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    const template = api.addPage({ title: "Weekly", markdown: "## Agenda" });
    api.templates.set(ds.id, [{ id: template.id, name: "Weekly", isDefault: true }]);
    api.failNext("retrievePageMarkdown", new NotionRequestError("service unavailable", 503, "service_unavailable"));
    const outcome = await waiting.createPage(ACTOR, { parentId: ds.id, title: "Week", templateId: template.id, request: {} });
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(await store.getContent(outcome.auditId)).toEqual({ before: "", after: "## Agenda" });
  });

  test("templates beyond the first 100 cannot be checked and are refused, saying so", async () => {
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    api.templates.set(ds.id, [{ id: "11111111-1111-4111-8111-111111111111", name: "First", isDefault: true }]);
    const listTemplates = api.listTemplates.bind(api);
    api.listTemplates = async (id) => ({ ...(await listTemplates(id)), more: true });
    const later = api.addPage({ title: "Template 101", markdown: "## x" });
    await expect(writes.createPage(ACTOR, { parentId: ds.id, title: "x", templateId: later.id, request: {} })).rejects.toThrow(
      '"template_id" is not one of the first 100 templates of this database',
    );
  });

  test("a template of another database, or any other page, is refused before anything is created", async () => {
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    const elsewhere = api.addPage({ title: "Other template", markdown: "## Other" });
    await expect(writes.createPage(ACTOR, { parentId: ds.id, title: "x", templateId: elsewhere.id, request: {} })).rejects.toThrow(
      '"template_id" is not one of the templates of this database',
    );
    expect(api.callsOf("createPage")).toEqual([]);
    expect((await store.list({ limit: 10, offset: 0 })).total).toBe(0);
  });

  test("a created page that now holds a child page or database is not trashed by a revert", async () => {
    const quick = new NotionWriteService(
      api,
      store,
      () => {},
      () => Promise.resolve(),
    );
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db",
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
    });
    // A template with an inline database: the new row gets its own copy, whose rows edit nothing on the page itself.
    const template = api.addPage({ title: "Log", markdown: '<database url="https://app.notion.com/p/1" inline="true"></database>' });
    api.templates.set(ds.id, [{ id: template.id, name: "Log", isDefault: true }]);
    const outcome = await quick.createPage(ACTOR, { parentId: ds.id, title: "Week", templateId: template.id, request: {} });
    const refused = await audit.revert(outcome.auditId, ADMIN);
    expect(refused).toEqual({ ok: false, reason: { kind: "has_child_objects" } });
    if (!refused.ok) expect(revertReasonText(outcome.auditId, refused.reason)).toContain("move it to the trash with notion_archive_page");
    expect(api.pages.get(outcome.pageId)!.in_trash).toBe(false);
  });

  test("create_page under a page: properties only, then the content (leading H1 included) is inserted at the end", async () => {
    const outcome = await writes.createPage(ACTOR, {
      parentId: parent.id,
      title: "New",
      content: "# Hi\n\n- a\n- b",
      request: { parent: parent.id, title: "New" },
    });

    const created = api.callsOf("createPage")[0];
    expect(created).toEqual({
      parent: { type: "page_id", page_id: parent.id },
      properties: { title: { title: [{ type: "text", text: { content: "New" } }] } },
    });
    expect(api.callsOf("updatePageMarkdown")).toEqual([
      {
        pageId: outcome.pageId,
        update: { type: "insert_content", insert_content: { content: "# Hi\n\n- a\n- b", position: { type: "end" } } },
      },
    ]);
    expect(api.markdown.get(outcome.pageId)).toBe("# Hi\n\n- a\n- b");
    expect(await store.getContent(outcome.auditId)).toEqual({ before: "", after: "# Hi\n\n- a\n- b" });
    const order = api.calls.map((c) => c.method).filter((m) => ["createPage", "updatePageMarkdown", "createComment"].includes(m));
    expect(order).toEqual(["createPage", "updatePageMarkdown", "createComment"]);

    expect(api.comments).toMatchObject([
      { pageId: outcome.pageId, author: "Alice (@alice, Discord)", text: `🤖 MCP 経由でページを作成しました — audit #${outcome.auditId}` },
    ]);
    const row = (await store.get(outcome.auditId))!;
    expect(row).toMatchObject({
      operation: "create_page",
      status: "ok",
      discordUserId: ACTOR.discordUserId,
      discordDisplayName: "Alice",
      discordUsername: "alice",
      targetPageId: outcome.pageId,
      snapshot: { parent: { type: "page_id", id: parent.id } },
      result: { pageId: outcome.pageId },
      error: null,
      commentError: null,
      request: { parent: parent.id, title: "New" },
    });
    expect(row.resultLastEditedTime).toBe(api.pages.get(outcome.pageId)!.last_edited_time);
  });

  test("create_page in a database resolves its single data source and validates properties", async () => {
    const ds = api.addDataSource({
      title: "Tasks",
      databaseId: "db1",
      properties: {
        Name: { id: "title", name: "Name", type: "title", title: {} },
        Done: { id: "d", name: "Done", type: "checkbox", checkbox: {} },
      },
    });
    const db = api.addDatabase({ title: "Tasks", dataSources: [{ id: ds.id, name: "Tasks" }] });

    await writes.createPage(ACTOR, { parentId: db.id, title: "Row", properties: { Done: { checkbox: true } }, request: {} });
    expect(api.callsOf("createPage")[0]).toMatchObject({
      parent: { type: "data_source_id", data_source_id: ds.id },
      properties: { Done: { checkbox: true }, Name: { title: [{ text: { content: "Row" } }] } },
    });

    await expect(
      writes.createPage(ACTOR, { parentId: db.id, title: "x", properties: { Nope: { checkbox: true } }, request: {} }),
    ).rejects.toThrow("Unknown properties: Nope");

    const ds2 = api.addDataSource({ title: "Archive", databaseId: "db2", properties: {} });
    const multi = api.addDatabase({
      title: "Multi",
      dataSources: [
        { id: ds.id, name: "Tasks" },
        { id: ds2.id, name: "Archive" },
      ],
    });
    await expect(writes.createPage(ACTOR, { parentId: multi.id, title: "x", request: {} })).rejects.toThrow(`data source id ${ds2.id}`);
  });

  test("create_page without content makes no markdown call; whitespace-only content is ignored", async () => {
    await writes.createPage(ACTOR, { parentId: parent.id, title: "Empty", content: "  \n", request: {} });
    expect(api.callsOf("updatePageMarkdown")).toEqual([]);
  });

  test("create_page whose content insert fails is still recorded (and revertible by trashing)", async () => {
    api.failNext("updatePageMarkdown", new NotionRequestError("Content too long", 400, "validation_error"));
    const outcome = await writes.createPage(ACTOR, { parentId: parent.id, title: "Half", content: "Body", request: {} });
    const warning: WriteWarning = { kind: "content_failed", error: expect.stringContaining("Content too long") };
    expect(outcome.warning).toEqual(warning);
    expect(writeWarningText(outcome.warning!)).toStartWith("Page created, but adding its content failed: ");
    const stored = (await store.get(outcome.auditId))!;
    expect(stored).toMatchObject({ status: "ok", error: null, note: warning });
    expect((await audit.revert(outcome.auditId, ADMIN)).ok).toBe(true);
    expect(api.pages.get(outcome.pageId)!.in_trash).toBe(true);
  });

  test("create_page rejects content that would create child pages, before creating anything", async () => {
    await expect(
      writes.createPage(ACTOR, { parentId: parent.id, title: "X", content: 'Intro\n<page url="">Child</page>', request: {} }),
    ).rejects.toThrow("notion_create_page");
    expect(api.callsOf("createPage")).toEqual([]);
  });

  test("append_content keeps the content before and after apart from the row, hashes it, and comments", async () => {
    api.markdown.set(parent.id, "Intro\nMiddle");
    const outcome = await writes.appendContent(ACTOR, { pageId: parent.id, content: "Added line", request: { content: "Added line" } });

    expect(api.callsOf("updatePageMarkdown")[0]).toEqual({
      pageId: parent.id,
      update: { type: "insert_content", insert_content: { content: "Added line", position: { type: "end" } } },
    });
    expect(api.markdown.get(parent.id)).toBe("Intro\nMiddle\nAdded line");
    const row = (await store.get(outcome.auditId))!;
    expect(row).toMatchObject({
      operation: "append_content",
      status: "ok",
      targetPageId: parent.id,
      error: null,
      result: { missedEdits: [] },
      snapshot: { beforeSha256: sha256("Intro\nMiddle"), afterSha256: sha256("Intro\nMiddle\nAdded line"), revertBlocker: null },
    });
    expect(JSON.stringify(row)).not.toContain("Intro");
    expect(await store.getContent(outcome.auditId)).toEqual({ before: "Intro\nMiddle", after: "Intro\nMiddle\nAdded line" });
    expect(api.comments.at(-1)).toMatchObject({
      pageId: parent.id,
      author: "Alice (@alice, Discord)",
      text: `🤖 MCP 経由で内容を追記しました — audit #${outcome.auditId}`,
    });
  });

  test("edits Notion found no match for are reported while the others apply, and the write stays revertible", async () => {
    api.markdown.set(parent.id, "One\nTwo");
    const outcome = await writes.editContent(ACTOR, {
      pageId: parent.id,
      edits: [
        { old_str: "One", new_str: "1" },
        { old_str: "Three", new_str: "3" },
      ],
      request: {},
    });
    expect(api.markdown.get(parent.id)).toBe("1\nTwo");
    expect(outcome).toMatchObject({ missedEdits: ["No matches found for Three."], warning: null });
    expect(await audit.revert(outcome.auditId, ADMIN)).toMatchObject({ ok: true });
    expect(api.markdown.get(parent.id)).toBe("One\nTwo");
  });

  test("pages too large for a revert to send back are not edited", async () => {
    api.markdown.set(parent.id, "x".repeat(450_001));
    await expect(writes.appendContent(ACTOR, { pageId: parent.id, content: "More", request: {} })).rejects.toThrow(
      "too large to edit revertibly",
    );
    expect(api.callsOf("updatePageMarkdown")).toEqual([]);
    expect((await store.list({ limit: 10, offset: 0 })).total).toBe(0);
  });

  test("append_content at the start", async () => {
    api.markdown.set(parent.id, "Body");
    await writes.appendContent(ACTOR, { pageId: parent.id, content: "Top", position: "start", request: {} });
    expect(api.markdown.get(parent.id)).toBe("Top\nBody");
  });

  test("edit_content sends the edits and records the change", async () => {
    api.markdown.set(parent.id, 'Hello <mention-user url="user://u1"/>\nSecond line');
    const outcome = await writes.editContent(ACTOR, {
      pageId: parent.id,
      edits: [
        { old_str: 'Hello <mention-user url="user://u1"/>', new_str: "Hi there" },
        { old_str: "Second line", new_str: "Second line\nThird line" },
      ],
      request: {},
    });
    expect(api.callsOf("updatePageMarkdown")[0].update).toEqual({
      type: "update_content",
      update_content: {
        content_updates: [
          { old_str: 'Hello <mention-user url="user://u1"/>', new_str: "Hi there" },
          { old_str: "Second line", new_str: "Second line\nThird line" },
        ],
      },
    });
    expect(api.markdown.get(parent.id)).toBe("Hi there\nSecond line\nThird line");
    expect(await store.get(outcome.auditId)).toMatchObject({ operation: "edit_content", status: "ok" });
    expect(api.comments.at(-1)!.text).toContain("本文を編集しました");
  });

  test("edit_content surfaces Notion's no-match / multiple-match errors and records a failed row", async () => {
    api.markdown.set(parent.id, "same\nsame\nother");
    const missing = await writes
      .editContent(ACTOR, { pageId: parent.id, edits: [{ old_str: "absent", new_str: "x" }], request: {} })
      .catch((e) => e);
    expect(missing).toBeInstanceOf(ToolError);
    expect(missing.message).toContain("No matches found");
    expect(missing.message).toContain("Call notion_get_page");
    const multiple = await writes
      .editContent(ACTOR, { pageId: parent.id, edits: [{ old_str: "same", new_str: "x" }], request: {} })
      .catch((e) => e);
    expect(multiple.message).toContain("Multiple matches found");
    expect(api.markdown.get(parent.id)).toBe("same\nsame\nother");
    expect(await store.get(1)).toMatchObject({
      status: "failed",
      operation: "edit_content",
      snapshot: { beforeSha256: sha256("same\nsame\nother") },
    });
    expect(api.comments).toEqual([]);
  });

  test("content writes reject child page / database tags", async () => {
    for (const tag of ['<page url="">P</page>', '<database url="">D</database>', '<data-source url="x"/>']) {
      await expect(writes.appendContent(ACTOR, { pageId: parent.id, content: tag, request: {} })).rejects.toThrow("notion_create_page");
      await expect(
        writes.editContent(ACTOR, { pageId: parent.id, edits: [{ old_str: "a", new_str: `a\n${tag}` }], request: {} }),
      ).rejects.toThrow("edits[0].new_str");
    }
    expect(api.callsOf("updatePageMarkdown")).toEqual([]);
  });

  test("content writes refuse truncated pages without changing them", async () => {
    api.markdown.set(parent.id, "Huge");
    api.truncated.set(parent.id, ["b1"]);
    await expect(writes.appendContent(ACTOR, { pageId: parent.id, content: "x", request: {} })).rejects.toThrow(
      "too large to edit revertibly",
    );
    expect(api.callsOf("updatePageMarkdown")).toEqual([]);
    expect((await store.list({ limit: 10, offset: 0 })).total).toBe(0);
  });

  test("a truncated write response is recorded with a warning and cannot be reverted automatically", async () => {
    api.markdown.set(parent.id, "Body");
    const original = api.updatePageMarkdown.bind(api);
    api.updatePageMarkdown = async (pageId, update) => ({ ...(await original(pageId, update)), truncated: true });
    const outcome = await writes.appendContent(ACTOR, { pageId: parent.id, content: "More", request: {} });
    expect(outcome.warning).toEqual({ kind: "revert_blocked", blocker: "truncated_after_write" });
    expect(writeWarningText(outcome.warning!)).toContain("automatic revert may not be possible");
    const row = (await store.get(outcome.auditId))!;
    expect(row).toMatchObject({ status: "ok", snapshot: { afterSha256: null, revertBlocker: "truncated_after_write" } });
    expect(await store.getContent(outcome.auditId)).toEqual({ before: "Body", after: null });
    expect(audit.revertability(row)).toEqual({ kind: "blocked", blocker: "truncated_after_write" });
    const result = await audit.revert(outcome.auditId, ADMIN);
    expect(result).toEqual({ ok: false, reason: { kind: "blocked", blocker: "truncated_after_write" } });
  });

  test("a write that Notion turned into a new child page cannot be reverted automatically; existing ones do not count", async () => {
    api.markdown.set(parent.id, '<page url="https://app.notion.com/p/old">Old</page>\nBody');
    const plain = await writes.appendContent(ACTOR, { pageId: parent.id, content: "More", request: {} });
    expect(plain.warning).toBeNull();

    // Content the check let through but Notion's parser read as a page tag.
    const original = api.updatePageMarkdown.bind(api);
    api.updatePageMarkdown = async (pageId, update) => {
      const after = await original(pageId, update);
      return { ...after, markdown: `${after.markdown}\n<page url="https://app.notion.com/p/new">New</page>` };
    };
    const outcome = await writes.appendContent(ACTOR, { pageId: parent.id, content: "Odd", request: {} });
    expect(outcome.warning).toEqual({ kind: "revert_blocked", blocker: "child_object_created" });
    const row = (await store.get(outcome.auditId))!;
    expect(row).toMatchObject({ status: "ok", snapshot: { revertBlocker: "child_object_created" } });
    expect(audit.revertability(row)).toEqual({ kind: "blocked", blocker: "child_object_created" });
  });

  test("update_properties snapshots only the changed keys (fetching truncated values in full)", async () => {
    const relation = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}` }));
    const row = addRow({
      Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue,
      Links: { id: "rel", type: "relation", relation, has_more: true } as unknown as PagePropertyValue,
      Other: { id: "oth", type: "checkbox", checkbox: true } as PagePropertyValue,
    });
    api.propertyItems.set(
      `${row.id}:rel`,
      Array.from({ length: 27 }, (_, i) => ({ object: "property_item", id: "rel", type: "relation", relation: { id: `r${i}` } })) as never,
    );

    const outcome = await writes.updateProperties(ACTOR, {
      pageId: row.id,
      properties: { Count: { number: 2 }, rel: { relation: [] } },
      request: {},
    });

    expect(outcome.changed).toEqual(["Count", "Links"]);
    const saved = (await store.get(outcome.auditId))!;
    const entries = (
      saved.snapshot as { properties: Array<{ name: string; id: string; value: { number?: number; relation?: unknown[] } }> }
    ).properties;
    expect(entries.map((e) => [e.name, e.id])).toEqual([
      ["Count", "cnt"],
      ["Links", "rel"],
    ]);
    expect(entries[0]!.value.number).toBe(1);
    expect(entries[1]!.value.relation).toHaveLength(27);
    expect(api.comments.at(-1)!.text).toContain("プロパティを更新しました");
  });

  test("update_properties writes by the id as Notion returns it, whichever name or id form was given", async () => {
    const row = addRow({ Count: { id: "%3Acnt", type: "number", number: 1 } as PagePropertyValue });
    const outcome = await writes.updateProperties(ACTOR, { pageId: row.id, properties: { ":cnt": { number: 2 } }, request: {} });
    expect(outcome.changed).toEqual(["Count"]);
    expect(api.callsOf("updatePage").at(-1).properties).toEqual({ "%3Acnt": { number: 2 } });
    expect((await api.retrievePage(row.id)).properties).toEqual({ Name: expect.anything(), Count: expect.objectContaining({ number: 2 }) });

    await expect(
      writes.updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: 3 }, "%3Acnt": { number: 4 } }, request: {} }),
    ).rejects.toThrow('Property "Count" is given more than once.');
  });

  test("update_properties refuses changes that could not be reverted", async () => {
    const row = addRow({
      Formula: { id: "f", type: "formula", formula: { type: "number", number: 1 } } as PagePropertyValue,
      Files: {
        id: "fl",
        type: "files",
        files: [{ name: "a.png", type: "file", file: { url: "u", expiry_time: "" } }],
      } as PagePropertyValue,
    });
    await expect(writes.updateProperties(ACTOR, { pageId: row.id, properties: { Formula: { number: 1 } }, request: {} })).rejects.toThrow(
      "cannot be written",
    );
    await expect(writes.updateProperties(ACTOR, { pageId: row.id, properties: { Files: { files: [] } }, request: {} })).rejects.toThrow(
      "could not be reverted",
    );
    await expect(writes.updateProperties(ACTOR, { pageId: row.id, properties: { Missing: { number: 1 } }, request: {} })).rejects.toThrow(
      'Unknown property "Missing"',
    );
    // A property id that is not valid escaping is compared as is, not decoded.
    const encoded = addRow({ Broken: { id: "%E0", type: "number", number: 1 } as PagePropertyValue });
    await expect(writes.updateProperties(ACTOR, { pageId: encoded.id, properties: { Other: { number: 2 } }, request: {} })).rejects.toThrow(
      'Unknown property "Other"',
    );
    expect(api.callsOf("updatePage")).toEqual([]);
    expect((await store.list({ limit: 10, offset: 0 })).total).toBe(0);
  });

  test("archive_page comments before archiving and stores the previous trash state", async () => {
    const page = api.addPage({ title: "Old" });
    const outcome = await writes.archivePage(ACTOR, { pageId: page.id, request: { page: page.id } });

    const order = api.calls.map((c) => c.method).filter((m) => m === "createComment" || m === "updatePage");
    expect(order).toEqual(["createComment", "updatePage"]);
    expect(api.pages.get(page.id)!.in_trash).toBe(true);
    expect(api.comments[0]!.text).toBe(`🤖 MCP 経由でページをアーカイブしました — audit #${outcome.auditId}`);
    expect(await store.get(outcome.auditId)).toMatchObject({
      status: "ok",
      snapshot: { inTrash: false },
      resultLastEditedTime: api.pages.get(page.id)!.last_edited_time,
    });
  });

  test("a failed archive takes its comment back", async () => {
    const page = api.addPage({ title: "Old" });
    api.failNext("updatePage", new NotionRequestError("Conflict occurred while saving.", 409, "conflict_error"));
    await expect(writes.archivePage(ACTOR, { pageId: page.id, request: {} })).rejects.toThrow("audit #1");
    expect(api.comments).toEqual([]);
    expect(await store.get(1)).toMatchObject({ status: "failed", commentError: null });
  });

  test("an archive Notion did not confirm keeps its comment and is recorded as interrupted", async () => {
    const page = api.addPage({ title: "Old" });
    api.failNext("updatePage", new NotionRequestError("Request to Notion API has timed out", 0, "notionhq_client_request_timeout"));
    await expect(writes.archivePage(ACTOR, { pageId: page.id, request: {} })).rejects.toThrow(
      "Notion did not confirm the change (timed out), so it may or may not have been applied (audit #1). Check whether the page is in the trash",
    );
    expect(api.comments).toHaveLength(1);
    expect(await store.get(1)).toMatchObject({ status: "interrupted", error: "Request to Notion API has timed out" });
  });

  test("a failed archive whose comment cannot be removed says so", async () => {
    const page = api.addPage({ title: "Old" });
    api.failNext("updatePage", new NotionRequestError("Conflict occurred while saving.", 409, "conflict_error"));
    api.failNext("deleteComment", new NotionRequestError("Could not find comment.", 404, "object_not_found"));
    await expect(writes.archivePage(ACTOR, { pageId: page.id, request: {} })).rejects.toThrow("audit #1");
    expect(api.comments).toHaveLength(1);
    expect(await store.get(1)).toMatchObject({
      status: "failed",
      commentError: "The attribution comment could not be removed: Could not find comment.",
    });
  });

  test("a content write that meets someone else's edit is applied but not revertible", async () => {
    api.markdown.set(parent.id, "Intro\n\nBody\n\nOutro");
    const write = api.updatePageMarkdown.bind(api);
    api.updatePageMarkdown = async (pageId, update) => {
      api.markdown.set(pageId, api.markdown.get(pageId)!.replace("Intro", "Intro (edited in the browser)"));
      return write(pageId, update);
    };
    const outcome = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    expect(outcome.warning).toEqual({ kind: "revert_blocked", blocker: "concurrent_edit" });
    expect((await store.get(outcome.auditId))!.snapshot).toMatchObject({ revertBlocker: "concurrent_edit" });
    expect(audit.revertability((await store.get(outcome.auditId))!)).toEqual({ kind: "blocked", blocker: "concurrent_edit" });
  });

  test("a failing comment does not fail the write; the error is stored", async () => {
    api.failNext("createComment", new NotionRequestError("Insufficient permissions for this endpoint.", 403, "restricted_resource"));
    const outcome = await writes.appendContent(ACTOR, { pageId: parent.id, content: "hello", request: {} });
    expect(outcome.commentError).toContain("Insufficient permissions");
    expect(await store.get(outcome.auditId)).toMatchObject({ status: "ok", commentError: "Insufficient permissions for this endpoint." });
  });

  test("a failed write is recorded as failed, without a comment", async () => {
    api.failNext("updatePage", new NotionRequestError("body failed validation", 400, "validation_error"));
    const row = addRow({ Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue });
    const error = await writes
      .updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: "x" } }, request: {} })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toBe("Notion rejected the request: body failed validation (audit #1)");
    expect(await store.get(1)).toMatchObject({ status: "failed", error: "body failed validation", operation: "update_properties" });
    expect(api.comments).toEqual([]);
  });

  test("a write Notion did not confirm is interrupted, and the caller is told to check before retrying", async () => {
    api.markdown.set(parent.id, "Intro");
    api.failNext("updatePageMarkdown", new NotionRequestError("Service Unavailable", 503, "service_unavailable"));
    const error = await writes.appendContent(ACTOR, { pageId: parent.id, content: "hello", request: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toBe(
      "Notion did not confirm the change (HTTP 503), so it may or may not have been applied (audit #1). Read the page with notion_get_page before retrying, or a retry may apply it twice.",
    );
    expect(await store.get(1)).toMatchObject({ status: "interrupted", error: "Service Unavailable" });
    expect(audit.revertability((await store.get(1))!)).toEqual({ kind: "not_ok", status: "interrupted" });

    api.failNext("createPage", new NotionRequestError("Bad Gateway", 502, "bad_gateway"));
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "Minutes", request: {} }).catch((e) => e);
    expect(created.message).toContain('Look for a page titled "Minutes" under the parent with notion_search');
    expect(created.logMessage).not.toContain("Minutes");
  });

  test("a content write whose page cannot be read back stores no last_edited_time (not the server clock)", async () => {
    api.markdown.set(parent.id, "Intro");
    const retrievePage = api.retrievePage.bind(api);
    let reads = 0;
    api.retrievePage = async (pageId: string) => {
      reads++;
      if (reads > 1) throw new NotionRequestError("service unavailable", 503, "service_unavailable");
      return retrievePage(pageId);
    };
    const outcome = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    const row = (await store.get(outcome.auditId))!;
    expect(row.status).toBe("ok");
    expect(row.resultLastEditedTime).toBeNull();
  });
});

describe("NotionAuditService.revert", () => {
  test("create_page: moves the created page to the trash and links both audit rows", async () => {
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "Oops", request: {} });
    const result = await audit.revert(created.auditId, ADMIN);

    expect(result).toEqual({ ok: true, revertAuditId: 2, partial: false, note: null });
    expect(api.pages.get(created.pageId)!.in_trash).toBe(true);
    expect(api.comments.at(-1)).toMatchObject({
      pageId: created.pageId,
      author: "Admin (Discord)",
      text: `↩️ audit #${created.auditId} を取り消しました`,
    });
    const original = (await store.get(created.auditId))!;
    expect(original.revertedBy).toBe(ADMIN.actorDiscordUserId);
    expect(original.revertAuditId).toBe(2);
    expect(original.revertedAt).toBeInstanceOf(Date);
    expect(await store.get(2)).toMatchObject({
      operation: "revert",
      status: "ok",
      discordUserId: ADMIN.actorDiscordUserId,
      revertOfAuditId: created.auditId,
      request: { auditId: created.auditId },
    });
  });

  test("append_content: puts the previous content back in one replace_content call", async () => {
    api.markdown.set(parent.id, "keep");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "- a\n\t- a1\n- b", request: {} });
    const result = await audit.revert(appended.auditId, ADMIN);
    expect(result).toEqual({ ok: true, revertAuditId: 2, partial: false, note: null });
    expect(api.markdown.get(parent.id)).toBe("keep");
    expect(api.callsOf("updatePageMarkdown").slice(1)).toEqual([
      { pageId: parent.id, update: { type: "replace_content", replace_content: { new_str: "keep" } } },
    ]);
    expect(api.comments.at(-1)!.text).toBe(`↩️ audit #${appended.auditId} を取り消しました`);
  });

  test("append_content into an empty page: revert empties it again", async () => {
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "# Title\nBody", request: {} });
    expect((await audit.revert(appended.auditId, ADMIN)).ok).toBe(true);
    expect(api.markdown.get(parent.id)).toBe("");
  });

  test("edit_content: restores the previous text, also inside toggles", async () => {
    const before = "Intro\n<details>\n<summary>More</summary>\n\tOld child\n</details>\nOutro";
    api.markdown.set(parent.id, before);
    const edited = await writes.editContent(ACTOR, {
      pageId: parent.id,
      edits: [
        { old_str: "\tOld child", new_str: "\tNew child\n\tSecond child" },
        { old_str: "Outro", new_str: "" },
      ],
      request: {},
    });
    expect(api.markdown.get(parent.id)).not.toBe(before);
    expect((await audit.revert(edited.auditId, ADMIN)).ok).toBe(true);
    expect(api.markdown.get(parent.id)).toBe(before);
  });

  test("content revert: refuses when the content changed afterwards, leaving later edits alone", async () => {
    api.markdown.set(parent.id, "Intro");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    api.setMarkdown(parent.id, "Intro\nmine\nsomeone else");

    const refused = await audit.revert(appended.auditId, ADMIN);
    expect(refused).toEqual({ ok: false, reason: { kind: "conflict", conflict: { kind: "content_changed" } } });
    expect(api.callsOf("updatePageMarkdown").length).toBe(1);
    expect(api.markdown.get(parent.id)).toBe("Intro\nmine\nsomeone else");
    expect((await store.list({ limit: 10, offset: 0 })).total).toBe(1);
  });

  test("content revert: a page edited between the check and the write is left alone", async () => {
    api.markdown.set(parent.id, "Intro");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    const read = api.retrievePageMarkdown.bind(api);
    let reads = 0;
    api.retrievePageMarkdown = async (pageId) => {
      // The check passes; someone edits before the second, last-moment read.
      if (++reads === 2) api.setMarkdown(pageId, "Intro\nmine\nmeanwhile");
      return read(pageId);
    };
    const result = await audit.revert(appended.auditId, ADMIN);
    expect(result).toMatchObject({ ok: false, reason: { kind: "failed", failure: { kind: "changed_meanwhile" } } });
    expect(api.markdown.get(parent.id)).toBe("Intro\nmine\nmeanwhile");
    expect(api.callsOf("updatePageMarkdown").length).toBe(1);
    expect((await store.get(appended.auditId))!.revertedAt).toBeNull();
  });

  test("content revert: a restore Notion refuses fails cleanly and leaves the row un-reverted", async () => {
    api.markdown.set(parent.id, "Intro");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    api.failNext(
      "updatePageMarkdown",
      new NotionRequestError("This operation would delete child pages or databases.", 400, "validation_error"),
    );

    const result = await audit.revert(appended.auditId, ADMIN);
    expect(result).toMatchObject({
      ok: false,
      reason: { kind: "failed", failure: { kind: "refused", notionMessage: expect.stringContaining("child pages") }, revertAuditId: 2 },
    });
    expect(api.markdown.get(parent.id)).toBe("Intro\nmine");
    expect((await store.get(appended.auditId))!.revertedAt).toBeNull();
    expect(await store.get(2)).toMatchObject({
      operation: "revert",
      status: "failed",
      error: expect.stringContaining("restore it by hand"),
    });
    for (const call of api.callsOf("updatePageMarkdown")) {
      expect(JSON.stringify(call.update)).not.toContain("allow_deleting_content");
    }
  });

  test("property edits do not count as content conflicts", async () => {
    api.markdown.set(parent.id, "Intro");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    api.touch(parent.id);
    expect((await audit.revert(appended.auditId, ADMIN)).ok).toBe(true);
  });

  test("update_properties: restores previous values keyed by property id", async () => {
    const row = addRow({
      Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue,
      Tags: { id: "tg", type: "multi_select", multi_select: [{ id: "o1", name: "A", color: "red" }] } as PagePropertyValue,
    });
    const updated = await writes.updateProperties(ACTOR, {
      pageId: row.id,
      properties: { Count: { number: 5 }, Tags: { multi_select: [] } },
      request: {},
    });
    const result = await audit.revert(updated.auditId, ADMIN);
    expect(result).toMatchObject({ ok: true, partial: false, note: null });
    expect(api.callsOf("updatePage").at(-1)).toEqual({
      pageId: row.id,
      properties: { cnt: { number: 1 }, tg: { multi_select: [{ id: "o1" }] } },
    });
  });

  test("archive_page: restores the page from the trash", async () => {
    const page = api.addPage({ title: "Old" });
    const archived = await writes.archivePage(ACTOR, { pageId: page.id, request: {} });
    const result = await audit.revert(archived.auditId, ADMIN);
    expect(result.ok).toBe(true);
    expect(api.pages.get(page.id)!.in_trash).toBe(false);
    expect(api.comments.at(-1)!.text).toBe(`↩️ audit #${archived.auditId} を取り消しました`);
  });

  test("refuses when a property it set changed afterwards, even within the same minute", async () => {
    const row = addRow({ Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue });
    const updated = await writes.updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: 2 } }, request: {} });
    // Someone sets it again without the minute-truncated last_edited_time moving.
    api.pages.get(row.id)!.properties.Count = { id: "cnt", type: "number", number: 7 };

    const refused = await audit.revert(updated.auditId, ADMIN);
    expect(refused).toMatchObject({ ok: false, reason: { kind: "conflict", conflict: { kind: "properties_changed", names: ["Count"] } } });
    expect(api.callsOf("updatePage").length).toBe(1);
  });

  test("edits to other properties are no conflict for a property revert", async () => {
    const row = addRow({
      Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue,
      Note: { id: "nt", type: "number", number: 0 } as PagePropertyValue,
    });
    const updated = await writes.updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: 2 } }, request: {} });
    await api.updatePage({ pageId: row.id, properties: { Note: { number: 5 } } });
    expect(await audit.revert(updated.auditId, ADMIN)).toMatchObject({ ok: true });
    expect(api.pages.get(row.id)!.properties.Note).toMatchObject({ number: 5 });
  });

  test("older property rows without the values after the write fall back to the edit time", async () => {
    const row = addRow({ Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue });
    const updated = await writes.updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: 2 } }, request: {} });
    const saved = (await store.get(updated.auditId))!;
    const properties = (saved.snapshot as { properties: Array<Record<string, unknown>> }).properties.map(
      ({ after: _after, ...entry }) => entry,
    );
    await overwriteAuditRow(db, updated.auditId, { snapshot: { properties } });
    api.touch(row.id);
    expect(await audit.revert(updated.auditId, ADMIN)).toMatchObject({
      ok: false,
      reason: { kind: "conflict", conflict: { kind: "edited_after" } },
    });
  });

  test("a create_page revert whose trashing fails takes its comment back", async () => {
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "New", request: {} });
    const comments = api.comments.length;
    api.failNext("updatePage", new NotionRequestError("Conflict occurred while saving.", 409, "conflict_error"));
    expect(await audit.revert(created.auditId, ADMIN)).toMatchObject({ ok: false, reason: { kind: "failed" } });
    expect(api.comments).toHaveLength(comments);
  });

  test("our own attribution comment does not count as a conflict", async () => {
    const row = addRow({ Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue });
    const updated = await writes.updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: 2 } }, request: {} });
    const saved = (await store.get(updated.auditId))!;
    expect(saved.resultLastEditedTime).toBe(api.pages.get(row.id)!.last_edited_time);
    expect((await audit.revert(updated.auditId, ADMIN)).ok).toBe(true);
  });

  test("refuses already reverted, failed writes, reverts and unknown ids", async () => {
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "A", request: {} });
    expect((await audit.revert(created.auditId, ADMIN)).ok).toBe(true);

    const again = await audit.revert(created.auditId, ADMIN);
    expect(again).toMatchObject({ ok: false, reason: { kind: "already_reverted", revertAuditId: 2 } });

    expect(await audit.revert(2, ADMIN)).toEqual({ ok: false, reason: { kind: "is_revert" } });

    api.failNext("createPage", new NotionRequestError("nope", 400, "validation_error"));
    await writes.createPage(ACTOR, { parentId: parent.id, title: "B", request: {} }).catch(() => {});
    expect(await audit.revert(3, ADMIN)).toEqual({ ok: false, reason: { kind: "not_ok", status: "failed" } });

    expect(await audit.revert(999, ADMIN)).toEqual({ ok: false, reason: { kind: "not_found" } });
  });

  test("restores what it can and reports a partial result", async () => {
    const row = addRow({ Count: { id: "cnt", type: "number", number: 3 } as PagePropertyValue });
    const inserted = await store.insert({
      discordUserId: ACTOR.discordUserId,
      discordDisplayName: ACTOR.displayName,
      operation: "update_properties",
      targetPageId: row.id,
      targetUrl: row.url,
      targetTitle: "Row",
      request: {},
      snapshot: {
        properties: [
          { name: "Count", id: "cnt", type: "number", value: { id: "cnt", type: "number", number: 1 } },
          {
            name: "Files",
            id: "fl",
            type: "files",
            value: { id: "fl", type: "files", files: [{ name: "a.png", type: "file", file: { url: "u", expiry_time: "" } }] },
          },
        ],
      },
      result: { changed: ["Count", "Files"] },
      status: "ok",
      resultLastEditedTime: row.last_edited_time,
    });

    const note: RevertNote = {
      kind: "properties_partial",
      restored: ["Count"],
      skipped: [{ name: "Files", refusal: { kind: "hosted_files", files: ["a.png"] } }],
    };
    const result = await audit.revert(inserted.id, ADMIN);
    expect(result).toMatchObject({ ok: true, partial: true, note });
    expect(api.callsOf("updatePage").at(-1).properties).toEqual({ cnt: { number: 1 } });
    expect((await store.get(inserted.id))!.revertNote).toEqual(note);
    expect(revertSuccessText(inserted.id, result as Extract<RevertResult, { ok: true }>)).toBe(
      `Reverted audit #${inserted.id}: Restored Count; could not restore "Files" (contains Notion-hosted file(s) (a.png) that cannot be re-set through the API).`,
    );
  });

  test("two processes reverting the same row at once touch Notion once", async () => {
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "Race", request: {} });
    const other = new NotionAuditService(store, api);
    const results = await Promise.all([audit.revert(created.auditId, ADMIN), other.revert(created.auditId, ADMIN)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      reason: { kind: expect.stringMatching(/^(in_progress|already_reverted)$/) },
    });
    expect(api.callsOf("updatePage").filter((call) => call.inTrash === true)).toHaveLength(1);
    expect((await audit.listAudit({ operation: "revert" })).total).toBe(1);
  });

  test("a revert Notion refuses is recorded as failed and leaves the original revertible", async () => {
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "A", request: {} });
    api.failNext("updatePage", new NotionRequestError("Conflict occurred while saving.", 409, "conflict_error"));
    const result = await audit.revert(created.auditId, ADMIN);
    expect(result).toEqual({
      ok: false,
      reason: { kind: "failed", failure: { kind: "error", message: "Conflict occurred while saving." }, revertAuditId: 2 },
    });
    expect(await store.get(2)).toMatchObject({ operation: "revert", status: "failed", revertOfAuditId: created.auditId });
    expect((await store.get(created.auditId))!.revertedAt).toBeNull();
    expect((await audit.revert(created.auditId, ADMIN)).ok).toBe(true);
  });

  test("a revert Notion did not confirm is interrupted, keeps its comment and leaves the original revertible", async () => {
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "A", request: {} });
    const comments = api.comments.length;
    api.failNext("updatePage", new NotionRequestError("service unavailable", 503, "service_unavailable"));
    const result = await audit.revert(created.auditId, ADMIN);
    expect(result).toEqual({
      ok: false,
      reason: { kind: "failed", failure: { kind: "unconfirmed", detail: "HTTP 503" }, revertAuditId: 2 },
    });
    expect(result.ok || revertReasonText(created.auditId, result.reason)).toBe(
      `Revert of audit #${created.auditId} failed: Notion did not confirm the revert (HTTP 503), so it may or may not have been applied. Read the page with notion_get_page before reverting audit #${created.auditId} again.`,
    );
    expect(await store.get(2)).toMatchObject({ operation: "revert", status: "interrupted", revertOfAuditId: created.auditId });
    expect(api.comments).toHaveLength(comments + 1);
    expect((await store.get(created.auditId))!.revertedAt).toBeNull();
    expect((await audit.revert(created.auditId, ADMIN)).ok).toBe(true);
  });

  test("refuses rows whose stored snapshot does not match the expected format, without touching Notion", async () => {
    api.markdown.set(parent.id, "Intro");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    const row = addRow({ Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue });
    const updated = await writes.updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: 2 } }, request: {} });
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "A", request: {} });
    await overwriteAuditRow(db, appended.auditId, { snapshot: { beforeSha256: "x", revertBlocker: "not a blocker" } });
    await overwriteAuditRow(db, updated.auditId, { snapshot: { properties: [{ name: "Count" }] } });
    await overwriteAuditRow(db, created.auditId, { result: { url: "https://example.invalid" } });
    const writesBefore = api.calls.filter((call) => ["updatePage", "updatePageMarkdown", "createComment"].includes(call.method)).length;

    for (const id of [appended.auditId, updated.auditId, created.auditId]) {
      const result = await audit.revert(id, ADMIN);
      expect(result).toEqual({ ok: false, reason: { kind: "unrecognized_snapshot" } });
      expect((await store.get(id))!.revertedAt).toBeNull();
    }
    const writesAfter = api.calls.filter((call) => ["updatePage", "updatePageMarkdown", "createComment"].includes(call.method)).length;
    expect(writesAfter).toBe(writesBefore);
    expect((await audit.listAudit({ operation: "revert" })).total).toBe(0);
  });
});

describe("NotionAuditService.failInterruptedWrites", () => {
  test("marks only pending rows older than 10 minutes as failed", async () => {
    const now = new Date("2026-10-12T12:00:00.000Z");
    const base = {
      discordUserId: ACTOR.discordUserId,
      discordDisplayName: ACTOR.displayName,
      operation: "archive_page" as const,
      targetTitle: "Notes",
      request: {},
      snapshot: { inTrash: false },
    };
    const stale = await insertAuditRow(db, { ...base, status: "pending", createdAt: new Date(now.getTime() - 11 * 60_000) });
    const recent = await insertAuditRow(db, { ...base, status: "pending", createdAt: new Date(now.getTime() - 5 * 60_000) });
    const done = await insertAuditRow(db, { ...base, status: "ok", createdAt: new Date(now.getTime() - 60 * 60_000) });

    expect(await audit.markInterruptedWrites(now)).toBe(1);
    expect(await store.get(stale.id)).toMatchObject({ status: "interrupted", error: null });
    expect(await store.get(recent.id)).toMatchObject({ status: "pending", error: null });
    expect(await store.get(done.id)).toMatchObject({ status: "ok", error: null });
    expect(await audit.markInterruptedWrites(now)).toBe(0);
  });
});

describe("NotionAuditStore", () => {
  const archiveRow = {
    discordUserId: ACTOR.discordUserId,
    discordDisplayName: ACTOR.displayName,
    operation: "archive_page" as const,
    targetTitle: "Notes",
    request: {},
    snapshot: { inTrash: false },
  };

  test("who did what and when cannot be written through the store", () => {
    // Type-only: these calls are never made.
    const rejected = [
      // @ts-expect-error the store's clock sets createdAt
      () => store.insert({ ...archiveRow, status: "ok", createdAt: new Date(0) }),
      // @ts-expect-error the actor stays as recorded
      () => store.finishPending(1, { status: "ok", discordUserId: "2" }),
      // @ts-expect-error the operation and its request stay as recorded
      () => store.finishPending(1, { status: "failed", error: "x", request: {} }),
    ];
    expect(rejected).toHaveLength(3);
  });

  test("a pending write ends once; a late real outcome replaces only the interruption guess", async () => {
    const pending = await store.insert({ ...archiveRow, status: "pending" });
    expect(await store.finishPending(pending.id, { status: "failed", error: "nope" })).toBe(true);
    expect(await store.finishPending(pending.id, { status: "ok", result: {} })).toBe(false);
    expect(await store.get(pending.id)).toMatchObject({ status: "failed", error: "nope" });

    const old = await insertAuditRow(db, { ...archiveRow, status: "pending", createdAt: new Date(Date.now() - 11 * 60_000) });
    expect(await audit.markInterruptedWrites()).toBe(1);
    expect(await store.finishPending(old.id, { status: "ok", result: {} })).toBe(true);
    expect(await store.get(old.id)).toMatchObject({ status: "ok" });
    expect(await store.finishPending(old.id, { status: "failed", error: "late" })).toBe(false);
  });

  test("a revert given up as interrupted does not overwrite a later revert of the same row", async () => {
    const original = await store.insert({ ...archiveRow, status: "ok" });
    const revert = { ...archiveRow, operation: "revert" as const, request: {}, revertOfAuditId: original.id };
    const first = (await store.startRevert(revert))!;
    expect(await store.startRevert(revert)).toBeNull();
    await overwriteAuditRow(db, first.id, { createdAt: new Date(Date.now() - 11 * 60_000) });
    expect(await audit.markInterruptedWrites()).toBe(1);

    const second = (await store.startRevert(revert))!;
    expect(await store.finishRevert(first.id, original.id, { status: "ok", result: {} }, { revertedBy: "a", revertNote: null })).toBe(
      false,
    );
    expect(await store.get(first.id)).toMatchObject({ status: "interrupted" });
    expect(await store.finishRevert(second.id, original.id, { status: "ok", result: {} }, { revertedBy: "b", revertNote: null })).toBe(
      true,
    );
    expect(await store.get(original.id)).toMatchObject({ revertAuditId: second.id, revertedBy: "b" });
  });

  test("the sweep marks stale pending writes right away and keeps running", async () => {
    await insertAuditRow(db, { ...archiveRow, status: "pending", createdAt: new Date(Date.now() - 11 * 60_000) });
    const events: EventEntry[] = [];
    const stop = startInterruptedWriteSweep({ audit, log: (entry) => events.push(entry), logError: () => {}, intervalMs: 60_000 });
    await Bun.sleep(10);
    stop();
    expect(events).toEqual([{ event: "audit_pending_interrupted", count: 1 }]);
  });
});

describe("NotionAuditService.listAudit", () => {
  test("filters by user, operation and status, newest first, with a total", async () => {
    await writes.appendContent(ACTOR, { pageId: parent.id, content: "a", request: {} });
    await writes.appendContent({ ...ACTOR, discordUserId: "300000000000000002" }, { pageId: parent.id, content: "b", request: {} });
    await writes.createPage(ACTOR, { parentId: parent.id, title: "c", request: {} });

    const all = await audit.listAudit({ limit: 2 });
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.id)).toEqual([3, 2]);
    expect((await audit.listAudit({ discordUserId: ACTOR.discordUserId })).rows.map((r) => r.id)).toEqual([3, 1]);
    expect((await audit.listAudit({ operation: "append_content", status: "ok" })).total).toBe(2);
    expect(await audit.getAudit(2)).toMatchObject({ discordUserId: "300000000000000002" });
  });
});
