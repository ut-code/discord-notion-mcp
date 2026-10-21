import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TokenBucketLimiter } from "../../src/lib/server/lib/rate-limit";
import { makeMember, OWNER_ID } from "../../src/lib/server/fakes/discord";
import { issueTokens, mcpCall, registerClient, signIn, startHarness, type Harness } from "../support/harness";

describe("TokenBucketLimiter", () => {
  test("allows a burst up to the capacity, then refills one token per second", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1, clock: () => now });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 1 });

    now += 500;
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 1 });
    now += 500;
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a").ok).toBe(false);

    now += 60_000;
    for (let i = 0; i < 3; i++) expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  test("keys have independent buckets", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, clock: () => 0 });
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
    expect(limiter.take("b").ok).toBe(true);
  });

  test("reports the wait for slow refill rates in whole seconds", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.1, clock: () => now });
    limiter.take("a");
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 10 });
    now += 2500;
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 8 });
  });
});

describe("tool call rate limit", () => {
  let h: Harness;
  let now = 0;
  let token = "";

  beforeAll(async () => {
    h = await startHarness({ toolRateLimit: new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1, clock: () => now }) });
    h.discord.members.set(OWNER_ID, makeMember(OWNER_ID));
    const { cookie } = await signIn(h, OWNER_ID);
    token = (await issueTokens(h, await registerClient(h), cookie)).access_token;
  });

  afterAll(() => h?.stop());

  const listEvents = (id: number) =>
    mcpCall(h, token, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "discord_list_events", arguments: {} } });

  test("applies to admins too and answers with a tool error, not an HTTP error", async () => {
    expect((await listEvents(1)).json.result.isError).toBeUndefined();
    expect((await listEvents(2)).json.result.isError).toBeUndefined();

    const limited = await listEvents(3);
    expect(limited.status).toBe(200);
    expect(limited.json.result).toEqual({ content: [{ type: "text", text: "Rate limit exceeded; retry in 1 s." }], isError: true });
    expect(h.toolLogs.at(-1)).toMatchObject({ tool: "discord_list_events", ok: false, error: "Rate limit exceeded; retry in 1 s." });

    now += 1000;
    expect((await listEvents(4)).json.result.isError).toBeUndefined();
  });
});
