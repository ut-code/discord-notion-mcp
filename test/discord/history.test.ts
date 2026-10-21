import { describe, expect, test } from "bun:test";
import { fetchHistory } from "../../src/lib/server/discord/history";
import { FakeDiscordApi, message } from "../../src/lib/server/fakes/discord";

const CHANNEL = "400000000000000001";

function seed(count: number): FakeDiscordApi {
  const api = new FakeDiscordApi();
  const base = 600000000000000000n;
  api.messages.set(
    CHANNEL,
    Array.from({ length: count }, (_, i) => message(String(base + BigInt(i)), CHANNEL, `m${i}`)),
  );
  return api;
}

describe("fetchHistory", () => {
  test("returns the latest messages oldest-first, paginating past 100", async () => {
    const api = seed(250);
    const pages: number[] = [];
    const result = await fetchHistory(
      (query) => {
        pages.push(query.limit);
        return api.fetchMessages(CHANNEL, query);
      },
      { limit: 150 },
    );
    expect(result).toHaveLength(150);
    expect(result[0]!.content).toBe("m100");
    expect(result.at(-1)!.content).toBe("m249");
    expect(pages).toEqual([100, 50]);
  });

  test("walks forward from `after`", async () => {
    const api = seed(250);
    const result = await fetchHistory((q) => api.fetchMessages(CHANNEL, q), { limit: 120, after: "600000000000000009" });
    expect(result.map((m) => m.content).slice(0, 2)).toEqual(["m10", "m11"]);
    expect(result).toHaveLength(120);
    expect(result.at(-1)!.content).toBe("m129");
  });

  test("stops at `after` when walking back from `before`", async () => {
    const api = seed(50);
    const result = await fetchHistory((q) => api.fetchMessages(CHANNEL, q), {
      limit: 200,
      before: "600000000000000040",
      after: "600000000000000030",
    });
    expect(result.map((m) => m.content)).toEqual(["m31", "m32", "m33", "m34", "m35", "m36", "m37", "m38", "m39"]);
  });

  test("handles short channels", async () => {
    const api = seed(3);
    expect(await fetchHistory((q) => api.fetchMessages(CHANNEL, q), { limit: 50 })).toHaveLength(3);
  });
});
