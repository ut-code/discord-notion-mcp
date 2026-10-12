import { describe, expect, test } from "bun:test";
import { composeServer } from "../../src/lib/server/compose";
import { loadConfig } from "../../src/lib/server/config";
import { openDatabase } from "../../src/lib/server/db/client";
import { FakeDiscordApi, GUILD_ID } from "../support/fakes";

const ENV = {
  PUBLIC_URL: "http://localhost:3917",
  BETTER_AUTH_SECRET: "compose-secret-compose-secret-compose",
  DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_CLIENT_SECRET: "x",
  DISCORD_BOT_TOKEN: "x",
  DISCORD_GUILD_ID: GUILD_ID,
};

describe("Notion configuration", () => {
  test("NOTION_TOKEN is optional", () => {
    expect(loadConfig(ENV).notion).toBeNull();
    expect(loadConfig({ ...ENV, NOTION_TOKEN: "" }).notion).toBeNull();
    expect(loadConfig({ ...ENV, NOTION_TOKEN: "ntn_secret" }).notion).toEqual({ token: "ntn_secret" });
  });

  test("without a token the Notion tools are not registered, but the audit log is still readable", async () => {
    const composed = await composeServer(loadConfig(ENV), { discordApi: new FakeDiscordApi(), database: openDatabase(":memory:") });
    expect(composed.notionEnabled).toBe(false);
    expect(composed.tools.some((tool) => tool.name.startsWith("notion_"))).toBe(false);
    expect(await composed.notionAudit.listAudit()).toEqual({ rows: [], total: 0 });
    expect(await composed.notionAudit.revert(1, { actorDiscordUserId: "1", actorDisplayName: "a" })).toMatchObject({ ok: false });
  });

  test("with a token the Notion tools are registered", async () => {
    const composed = await composeServer(loadConfig({ ...ENV, NOTION_TOKEN: "ntn_secret" }), {
      discordApi: new FakeDiscordApi(),
      database: openDatabase(":memory:"),
    });
    expect(composed.notionEnabled).toBe(true);
    const names = composed.tools.filter((tool) => tool.name.startsWith("notion_")).map((tool) => tool.name);
    expect(names.length).toBe(12);
    expect(names).toContain("notion_append_content");
    expect(names).toContain("notion_edit_content");
    expect(names).not.toContain("notion_append_blocks");
  });
});
