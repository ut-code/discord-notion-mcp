import { describe, expect, test } from "bun:test";
import { RateLimitError } from "@discordjs/rest";
import { exceedsRateLimitWait } from "../../src/lib/server/discord/api";
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
});
