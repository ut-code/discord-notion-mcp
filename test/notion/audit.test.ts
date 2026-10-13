import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, runAppMigrations } from "../../src/lib/server/db/client";
import { ToolError } from "../../src/lib/server/lib/errors";
import { NotionRequestError, type NotionPage } from "../../src/lib/server/notion/client/api";
import type { Actor } from "../../src/lib/server/notion/changes/attribution";
import { NotionAuditService } from "../../src/lib/server/notion/changes/audit-service";
import { NotionAuditStore } from "../../src/lib/server/notion/changes/audit-store";
import { NotionWriteService } from "../../src/lib/server/notion/changes/write-service";
import { sha256 } from "../../src/lib/server/notion/content/content-diff";
import type { PagePropertyValue } from "../../src/lib/server/notion/content/properties";
import { FakeNotionApi, titleValue } from "../support/notion-fakes";

const ACTOR: Actor = { discordUserId: "300000000000000001", displayName: "Alice", username: "alice" };
const ADMIN = { actorDiscordUserId: "300000000000000009", actorDisplayName: "Admin" };

let api: FakeNotionApi;
let store: NotionAuditStore;
let writes: NotionWriteService;
let audit: NotionAuditService;
let parent: NotionPage;

beforeEach(() => {
  const database = openDatabase(":memory:");
  runAppMigrations(database.db);
  api = new FakeNotionApi();
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
    const order = api.calls.map((c) => c.method).filter((m) => ["createPage", "updatePageMarkdown", "createComment"].includes(m));
    expect(order).toEqual(["createPage", "updatePageMarkdown", "createComment"]);

    expect(api.comments).toEqual([
      { pageId: outcome.pageId, text: `🤖 Alice (@alice, Discord) が MCP 経由でページを作成しました — audit #${outcome.auditId}` },
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
    expect(outcome.warning).toContain("Page created, but adding its content failed");
    expect(await store.get(outcome.auditId)).toMatchObject({ status: "ok", error: expect.stringContaining("Content too long") });
    expect((await audit.revert(outcome.auditId, ADMIN)).ok).toBe(true);
    expect(api.pages.get(outcome.pageId)!.in_trash).toBe(true);
  });

  test("create_page rejects content that would create child pages, before creating anything", async () => {
    await expect(
      writes.createPage(ACTOR, { parentId: parent.id, title: "X", content: 'Intro\n<page url="">Child</page>', request: {} }),
    ).rejects.toThrow("notion_create_page");
    expect(api.callsOf("createPage")).toEqual([]);
  });

  test("append_content stores an inverse edit, hashes and hunks (not the whole page) and comments", async () => {
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
      result: { changedHunks: 1 },
      snapshot: {
        beforeSha256: sha256("Intro\nMiddle"),
        afterSha256: sha256("Intro\nMiddle\nAdded line"),
        inverse: {
          type: "update_content",
          update_content: { content_updates: [{ old_str: "Middle\nAdded line", new_str: "Middle" }] },
        },
        revertBlocker: null,
        hunks: [{ before: "", after: "Added line" }],
      },
    });
    expect(JSON.stringify(row.snapshot)).not.toContain("Intro");
    expect(api.comments.at(-1)).toEqual({
      pageId: parent.id,
      text: `🤖 Alice (@alice, Discord) が MCP 経由で内容を追記しました — audit #${outcome.auditId}`,
    });
  });

  test("append_content at the start", async () => {
    api.markdown.set(parent.id, "Body");
    await writes.appendContent(ACTOR, { pageId: parent.id, content: "Top", position: "start", request: {} });
    expect(api.markdown.get(parent.id)).toBe("Top\nBody");
  });

  test("edit_content sends the edits, strips mention labels and records the change", async () => {
    api.markdown.set(parent.id, 'Hello <mention-user url="user://u1"/>\nSecond line');
    const outcome = await writes.editContent(ACTOR, {
      pageId: parent.id,
      edits: [
        { old_str: 'Hello <mention-user url="user://u1">Alice</mention-user>', new_str: "Hi there" },
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
    expect(outcome.warning).toContain("automatic revert may not be possible");
    const row = (await store.get(outcome.auditId))!;
    expect(row).toMatchObject({ status: "ok", snapshot: { afterSha256: null, inverse: null } });
    const result = await audit.revert(outcome.auditId, ADMIN);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("cannot be reverted automatically") });
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
    expect(api.callsOf("updatePage")).toEqual([]);
    expect((await store.list({ limit: 10, offset: 0 })).total).toBe(0);
  });

  test("archive_page comments before archiving and stores the previous trash state", async () => {
    const page = api.addPage({ title: "Old" });
    const outcome = await writes.archivePage(ACTOR, { pageId: page.id, request: { page: page.id } });

    const order = api.calls.map((c) => c.method).filter((m) => m === "createComment" || m === "updatePage");
    expect(order).toEqual(["createComment", "updatePage"]);
    expect(api.pages.get(page.id)!.in_trash).toBe(true);
    expect(api.comments[0]!.text).toBe(`🤖 Alice (@alice, Discord) が MCP 経由でページをアーカイブしました — audit #${outcome.auditId}`);
    expect(await store.get(outcome.auditId)).toMatchObject({
      status: "ok",
      snapshot: { inTrash: false },
      resultLastEditedTime: api.pages.get(page.id)!.last_edited_time,
    });
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

    expect(result).toEqual({ ok: true, message: `Reverted audit #${created.auditId}.`, revertAuditId: 2 });
    expect(api.pages.get(created.pageId)!.in_trash).toBe(true);
    expect(api.comments.at(-1)).toEqual({ pageId: created.pageId, text: `↩️ Admin が audit #${created.auditId} を取り消しました` });
    const original = (await store.get(created.auditId))!;
    expect(original.revertedBy).toBe(ADMIN.actorDiscordUserId);
    expect(original.revertAuditId).toBe(2);
    expect(original.revertedAt).toBeInstanceOf(Date);
    expect(await store.get(2)).toMatchObject({
      operation: "revert",
      status: "ok",
      discordUserId: ADMIN.actorDiscordUserId,
      revertOfAuditId: created.auditId,
      request: { auditId: created.auditId, force: false },
    });
  });

  test("append_content: removes the appended content in one update_content call", async () => {
    api.markdown.set(parent.id, "keep");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "- a\n\t- a1\n- b", request: {} });
    const result = await audit.revert(appended.auditId, ADMIN);
    expect(result).toEqual({ ok: true, message: `Reverted audit #${appended.auditId}.`, revertAuditId: 2 });
    expect(api.markdown.get(parent.id)).toBe("keep");
    const reverts = api.callsOf("updatePageMarkdown").slice(1);
    expect(reverts.length).toBe(1);
    expect(reverts[0].update.type).toBe("update_content");
    expect(api.comments.at(-1)!.text).toBe(`↩️ Admin が audit #${appended.auditId} を取り消しました`);
  });

  test("append_content into an empty page: revert empties it again", async () => {
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "# Title\nBody", request: {} });
    expect((await store.get(appended.auditId))!.snapshot).toMatchObject({
      inverse: { update_content: { content_updates: [{ old_str: "# Title\nBody", new_str: "" }] } },
    });
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

  test("content revert: refuses when the content changed, force succeeds while the context still matches", async () => {
    api.markdown.set(parent.id, "Intro");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    api.setMarkdown(parent.id, "Intro\nmine\nsomeone else");

    const refused = await audit.revert(appended.auditId, ADMIN);
    expect(refused).toMatchObject({ ok: false, conflict: true });
    expect(refused.message).toContain("content changed after audit #1");
    expect(api.callsOf("updatePageMarkdown").length).toBe(1);

    const forced = await audit.revert(appended.auditId, { ...ADMIN, force: true });
    expect(forced.ok).toBe(true);
    expect(forced.message).toContain("forced");
    expect(api.markdown.get(parent.id)).toBe("Intro\nsomeone else");
    expect(await store.get(2)).toMatchObject({ request: { auditId: 1, force: true }, status: "ok" });
  });

  test("content revert: force with broken context fails cleanly and leaves the row un-reverted", async () => {
    api.markdown.set(parent.id, "Intro");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    api.setMarkdown(parent.id, "Intro\nrewritten by someone");

    const forced = await audit.revert(appended.auditId, { ...ADMIN, force: true });
    expect(forced.ok).toBe(false);
    expect(forced.message).toContain("cannot be reverted automatically");
    expect(forced.message).toContain("No matches found");
    expect(api.markdown.get(parent.id)).toBe("Intro\nrewritten by someone");
    expect((await store.get(appended.auditId))!.revertedAt).toBeNull();
    expect(await store.get(2)).toMatchObject({ operation: "revert", status: "failed" });
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
    expect(result.ok).toBe(true);
    expect(result.partial).toBeUndefined();
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
    expect(api.comments.at(-1)!.text).toBe(`↩️ Admin が audit #${archived.auditId} を取り消しました`);
  });

  test("refuses when the page changed after the write, unless forced", async () => {
    const row = addRow({ Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue });
    const updated = await writes.updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: 2 } }, request: {} });
    api.touch(row.id);

    const refused = await audit.revert(updated.auditId, ADMIN);
    expect(refused.ok).toBe(false);
    expect(refused).toMatchObject({ ok: false, conflict: true });
    expect(refused.message).toContain("edited after audit #1");
    expect(api.callsOf("updatePage").length).toBe(1);

    const forced = await audit.revert(updated.auditId, { ...ADMIN, force: true });
    expect(forced.ok).toBe(true);
    expect(forced.message).toContain("forced");
    expect(await store.get(2)).toMatchObject({ request: { auditId: 1, force: true } });
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
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining("already reverted") });

    const ofRevert = await audit.revert(2, ADMIN);
    expect(ofRevert).toEqual({ ok: false, message: "Reverting a revert is not supported." });

    api.failNext("createPage", new NotionRequestError("nope", 400, "validation_error"));
    await writes.createPage(ACTOR, { parentId: parent.id, title: "B", request: {} }).catch(() => {});
    expect(await audit.revert(3, ADMIN)).toMatchObject({ ok: false, message: expect.stringContaining("failed write") });

    expect(await audit.revert(999, ADMIN)).toEqual({ ok: false, message: "Audit #999 not found." });
  });

  test("restores what it can and reports a partial result", async () => {
    const row = addRow({ Count: { id: "cnt", type: "number", number: 3 } as PagePropertyValue });
    const inserted = await store.insert({
      discordUserId: ACTOR.discordUserId,
      discordDisplayName: ACTOR.displayName,
      operation: "update_properties",
      targetPageId: row.id,
      targetUrl: row.url,
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

    const result = await audit.revert(inserted.id, ADMIN);
    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.message).toContain("Restored Count");
    expect(result.message).toContain("a.png");
    expect(api.callsOf("updatePage").at(-1).properties).toEqual({ cnt: { number: 1 } });
    expect((await store.get(inserted.id))!.revertNote).toContain("could not restore");
  });

  test("a Notion error during revert is recorded as a failed revert and leaves the original revertible", async () => {
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "A", request: {} });
    api.failNext("updatePage", new NotionRequestError("service unavailable", 503, "service_unavailable"));
    const result = await audit.revert(created.auditId, ADMIN);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("service unavailable");
    expect(await store.get(2)).toMatchObject({ operation: "revert", status: "failed", revertOfAuditId: created.auditId });
    expect((await store.get(created.auditId))!.revertedAt).toBeNull();
    expect((await audit.revert(created.auditId, ADMIN)).ok).toBe(true);
  });

  test("refuses rows whose stored snapshot does not match the expected format, without touching Notion", async () => {
    api.markdown.set(parent.id, "Intro");
    const appended = await writes.appendContent(ACTOR, { pageId: parent.id, content: "mine", request: {} });
    const row = addRow({ Count: { id: "cnt", type: "number", number: 1 } as PagePropertyValue });
    const updated = await writes.updateProperties(ACTOR, { pageId: row.id, properties: { Count: { number: 2 } }, request: {} });
    const created = await writes.createPage(ACTOR, { parentId: parent.id, title: "A", request: {} });
    await store.update(appended.auditId, { snapshot: { beforeSha256: "x", inverse: "not an update" } });
    await store.update(updated.auditId, { snapshot: { properties: [{ name: "Count" }] } });
    await store.update(created.auditId, { result: { url: "https://example.invalid" } });
    const writesBefore = api.calls.filter((call) => ["updatePage", "updatePageMarkdown", "createComment"].includes(call.method)).length;

    for (const id of [appended.auditId, updated.auditId, created.auditId]) {
      const result = await audit.revert(id, ADMIN);
      expect(result).toEqual({
        ok: false,
        message: `Audit #${id} has an unrecognized snapshot format; it cannot be reverted automatically.`,
      });
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
      request: {},
      snapshot: { inTrash: false },
    };
    const stale = await store.insert({ ...base, status: "pending", createdAt: new Date(now.getTime() - 11 * 60_000) });
    const recent = await store.insert({ ...base, status: "pending", createdAt: new Date(now.getTime() - 5 * 60_000) });
    const done = await store.insert({ ...base, status: "ok", createdAt: new Date(now.getTime() - 60 * 60_000) });

    expect(await audit.failInterruptedWrites(now)).toBe(1);
    expect(await store.get(stale.id)).toMatchObject({ status: "failed", error: "interrupted (server restarted)" });
    expect(await store.get(recent.id)).toMatchObject({ status: "pending", error: null });
    expect(await store.get(done.id)).toMatchObject({ status: "ok", error: null });
    expect(await audit.failInterruptedWrites(now)).toBe(0);
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
