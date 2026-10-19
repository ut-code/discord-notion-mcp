import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { toolsPage } from "../../src/lib/server/dashboard/tools";
import type { AnyToolDefinition } from "../../src/lib/server/mcp/registry";
import { toolListing } from "../../src/lib/server/mcp/tool-listing";

function tool(name: string, permission: AnyToolDefinition["permission"], inputSchema: z.ZodObject): AnyToolDefinition {
  return { name, title: `Title of ${name}`, description: `Does ${name}.`, permission, inputSchema, handler: () => Promise.resolve("") };
}

const tools = [
  tool(
    "discord_search",
    "discord:read",
    z.object({
      query: z.string().describe("Words to search for"),
      has: z.array(z.enum(["image", "link"])).optional(),
      limit: z.number().int().default(25).describe("Results per page"),
    }),
  ),
  tool("notion_archive", "notion:write", z.object({})),
].map(toolListing);

describe("tools page", () => {
  test("groups tools by permission and reads parameters off the schema the AI gets", () => {
    const data = toolsPage({ tools }, { permissions: ["discord:read"] });
    expect(data.groups.map((group) => [group.label, group.available, group.tools.map((entry) => entry.name)])).toEqual([
      ["Discord 閲覧", true, ["discord_search"]],
      ["Notion 編集", false, ["notion_archive"]],
    ]);
    const [search] = data.groups[0]!.tools;
    expect(search).toMatchObject({ title: "Title of discord_search", description: "Does discord_search." });
    expect(search!.parameters).toEqual([
      { name: "query", type: "string", required: true, description: "Words to search for", defaultValue: null },
      { name: "has", type: '("image" | "link")[]', required: false, description: null, defaultValue: null },
      { name: "limit", type: "integer", required: false, description: "Results per page", defaultValue: "25" },
    ]);
    expect(JSON.parse(search!.schema)).toEqual(tools[0]!.inputSchema);
    expect(data.groups[1]!.tools[0]!.parameters).toEqual([]);
  });
});
