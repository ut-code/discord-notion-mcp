import { describe, expect, test } from "bun:test";
import { DiscordAPIError, RateLimitError } from "@discordjs/rest";
import { exceedsRateLimitWait } from "../../src/lib/server/discord/api";
import { ToolError } from "../../src/lib/server/lib/errors";
import { withDiscordErrors } from "../../src/lib/server/discord/tools/shared";
import type { Principal } from "../../src/lib/server/mcp/registry";

const limit = {
  timeToReset: 4200,
  limit: 5,
  method: "GET",
  hash: "h",
  url: "https://discord.com/api/v10/guilds/1/members/search",
  route: "/guilds/:id/members/search",
  majorParameter: "1",
  global: false,
  retryAfter: 4200,
  sublimitTimeout: 0,
  scope: "user" as const,
};

describe("Discord errors", () => {
  test("rate limits of at most 2 s are waited out, longer ones are not", () => {
    expect([1000, 2000, 2001, 4200].map((retryAfter) => exceedsRateLimitWait({ retryAfter }))).toEqual([false, false, true, true]);
  });

  test("a rate limit too long to wait out tells when to retry", async () => {
    const handler = withDiscordErrors(() => Promise.reject(new RateLimitError(limit)));

    await expect(handler({}, { principal: {} as Principal })).rejects.toThrow("Discord rate limit reached; retry in about 5 s.");
  });

  test("a 400 keeps Discord's code for the log, or says it had none (an HTML page from Discord's edge)", async () => {
    const rejected = async (error: DiscordAPIError) => {
      const caught = await withDiscordErrors(() => Promise.reject(error))({}, { principal: {} as Principal }).catch(
        (thrown: unknown) => thrown,
      );
      return caught instanceof ToolError ? { message: caught.message, logMessage: caught.logMessage } : caught;
    };
    const json = new DiscordAPIError({ code: 50035, message: "Invalid Form Body" }, 50035, 400, "GET", "/search", {});
    expect(await rejected(json)).toEqual({
      message: "Discord rejected the request: Invalid Form Body",
      logMessage: "Discord rejected the request (400 50035)",
    });
    const html = new DiscordAPIError(new ArrayBuffer(0) as never, undefined as never, 400, "GET", "/search", {});
    expect(await rejected(html)).toEqual({
      message: "Discord rejected the request.",
      logMessage: "Discord rejected the request (400 without a JSON body)",
    });
  });
});
