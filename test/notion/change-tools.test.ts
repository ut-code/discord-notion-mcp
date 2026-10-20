import { beforeEach, describe, expect, test } from "bun:test";
import { PERMISSIONS, type Permission } from "../../src/lib/server/permissions/permissions";
import { openDatabase, runAppMigrations, type DatabaseHandle } from "../../src/lib/server/db/client";
import type { AnyToolDefinition, Principal } from "../../src/lib/server/mcp/registry";
import type { Actor } from "../../src/lib/server/notion/changes/attribution";
import { NotionAuditService } from "../../src/lib/server/notion/changes/audit-service";
import { NotionAuditStore } from "../../src/lib/server/notion/changes/audit-store";
import { NotionWriteService } from "../../src/lib/server/notion/changes/write-service";
import { createNotionChangeTools } from "../../src/lib/server/notion/tools/changes";
import { makeGuild, makeMember } from "../support/fakes";
import { FakeNotionApi } from "../support/notion-fakes";

const ALICE = "300000000000000001";
const BOB = "300000000000000002";
const ADMIN = "300000000000000009";

function principalFor(discordUserId: string, isAdmin = false): Principal {
  const permissions = new Set<Permission>(isAdmin ? PERMISSIONS : ["notion:read", "notion:write"]);
  return {
    userId: `u-${discordUserId}`,
    discordUserId,
    access: { isMember: true, discordUserId, guild: makeGuild(), member: makeMember(discordUserId), permissions, isAdmin },
  };
}

function actorFor(discordUserId: string): Actor {
  return { discordUserId, displayName: `name-${discordUserId.slice(-1)}`, username: null };
}

const PUBLIC_URL = "https://mcp.example.com";

let database: DatabaseHandle;
let api: FakeNotionApi;
let writes: NotionWriteService;
let tools: Map<string, AnyToolDefinition>;

async function call(name: string, principal: Principal, args: Record<string, unknown> = {}): Promise<string> {
  const tool = tools.get(name)!;
  const result = await tool.handler(tool.inputSchema.parse(args), { principal });
  return typeof result === "string" ? result : JSON.stringify(result);
}

beforeEach(() => {
  database = openDatabase(":memory:");
  runAppMigrations(database.db);
  api = new FakeNotionApi();
  const store = new NotionAuditStore(database.db);
  writes = new NotionWriteService(api, store);
  tools = new Map(
    createNotionChangeTools({ audit: new NotionAuditService(store, api), publicUrl: PUBLIC_URL }).map((tool) => [tool.name, tool]),
  );
});

async function seed(): Promise<{ alice: number; bob: number }> {
  const parent = api.addPage({ title: "Parent" });
  const alice = await writes.createPage(actorFor(ALICE), { parentId: parent.id, title: "A", request: {} });
  const bob = await writes.createPage(actorFor(BOB), { parentId: parent.id, title: "B", request: {} });
  return { alice: alice.auditId, bob: bob.auditId };
}

describe("notion_list_recent_changes", () => {
  test("lists only the caller's own rows by default", async () => {
    const ids = await seed();
    const text = await call("notion_list_recent_changes", principalFor(ALICE));
    expect(text).toContain("1 of 1 change(s) by you");
    expect(text).toContain(`- #${ids.alice} `);
    expect(text).not.toContain(`- #${ids.bob} `);
    expect(text).toContain("create_page | ok");
  });

  test("non-admins cannot list other users; admins can list everyone or one user", async () => {
    const ids = await seed();
    await expect(call("notion_list_recent_changes", principalFor(ALICE), { all_users: true })).rejects.toThrow("Only admins");
    await expect(call("notion_list_recent_changes", principalFor(ALICE), { discord_user_id: BOB })).rejects.toThrow("Only admins");
    expect(await call("notion_list_recent_changes", principalFor(ALICE), { discord_user_id: ALICE })).toContain(`- #${ids.alice} `);

    const all = await call("notion_list_recent_changes", principalFor(ADMIN, true), { all_users: true });
    expect(all).toContain("2 of 2 change(s) by all users");
    expect(all.indexOf(`- #${ids.bob} `)).toBeLessThan(all.indexOf(`- #${ids.alice} `));
    expect(all).toContain(`by name-2 (${BOB})`);

    const one = await call("notion_list_recent_changes", principalFor(ADMIN, true), { discord_user_id: BOB });
    expect(one).toContain(`- #${ids.bob} `);
    expect(one).not.toContain(`- #${ids.alice} `);
  });

  test("respects the limit", async () => {
    const parent = api.addPage({ title: "P" });
    for (let i = 0; i < 3; i++) await writes.appendContent(actorFor(ALICE), { pageId: parent.id, content: `x${i}`, request: {} });
    const text = await call("notion_list_recent_changes", principalFor(ALICE), { limit: 2 });
    expect(text).toContain("2 of 3 change(s)");
  });
});

describe("notion_revert_change", () => {
  test("members revert their own rows only; admins revert anyone's", async () => {
    const ids = await seed();
    await expect(call("notion_revert_change", principalFor(ALICE), { audit_id: ids.bob })).rejects.toThrow(
      `Audit #${ids.bob} not found or not accessible.`,
    );
    await expect(call("notion_revert_change", principalFor(ALICE), { audit_id: 999 })).rejects.toThrow(
      "Audit #999 not found or not accessible.",
    );

    expect(await call("notion_revert_change", principalFor(ALICE), { audit_id: ids.alice })).toBe(`Reverted audit #${ids.alice}.`);
    expect(api.comments.at(-1)).toMatchObject({
      author: expect.stringContaining("user0001"),
      text: `↩️ audit #${ids.alice} を取り消しました`,
    });

    expect(await call("notion_revert_change", principalFor(ADMIN, true), { audit_id: ids.bob })).toBe(`Reverted audit #${ids.bob}.`);
    const listed = await call("notion_list_recent_changes", principalFor(ALICE));
    expect(listed).toContain("reverted");
    expect(listed).toContain(`reverts #${ids.alice}`);
  });

  test("a conflict is refused, leaving the later edits, and points to the change on the dashboard", async () => {
    const parent = api.addPage({ title: "P", markdown: "Intro" });
    const appended = await writes.appendContent(actorFor(ALICE), { pageId: parent.id, content: "mine", request: {} });
    api.setMarkdown(parent.id, "Intro\nmine\nlater edit");

    for (const principal of [principalFor(ALICE), principalFor(ADMIN, true)]) {
      const error = await call("notion_revert_change", principal, { audit_id: appended.auditId, force: true }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Not reverted: the page changed after the write.");
      expect((error as Error).message).toContain("content changed after audit");
      expect((error as Error).message).toContain(
        `Fix the page by hand; the change is shown at ${PUBLIC_URL}/dashboard/audit/${appended.auditId}.`,
      );
    }
    expect(api.markdown.get(parent.id)).toBe("Intro\nmine\nlater edit");
  });

  test("without a public URL the dashboard link is a path", async () => {
    const store = new NotionAuditStore(database.db);
    const [, revert] = createNotionChangeTools({ audit: new NotionAuditService(store, api) });
    const parent = api.addPage({ title: "P", markdown: "Intro" });
    const appended = await writes.appendContent(actorFor(ALICE), { pageId: parent.id, content: "mine", request: {} });
    api.setMarkdown(parent.id, "Intro\nmine\nlater edit");
    const error = await revert!
      .handler(revert!.inputSchema.parse({ audit_id: appended.auditId }) as never, { principal: principalFor(ALICE) })
      .catch((e: Error) => e);
    expect((error as Error).message).toContain(`the change is shown at /dashboard/audit/${appended.auditId}.`);
  });

  test("the revert tool has no force option and says a changed page is fixed by hand", () => {
    const revert = tools.get("notion_revert_change")!;
    expect(Object.keys(revert.inputSchema.shape)).toEqual(["audit_id"]);
    expect(revert.description).toContain("the page then has to be fixed by hand");
    expect(tools.get("notion_list_recent_changes")!.annotations?.readOnlyHint).toBe(true);
  });
});
