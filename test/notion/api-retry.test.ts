import { describe, expect, test } from "bun:test";
import { APIErrorCode, APIResponseError, type Client } from "@notionhq/client";
import { NotionRequestError, SdkNotionApi } from "../../src/lib/server/notion/client/api";
import { toToolError } from "../../src/lib/server/notion/client/resolve";

function apiError(status: number, code: APIErrorCode, retryAfter?: string): APIResponseError {
  return new APIResponseError({
    code,
    status,
    message: code,
    headers: new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    rawBodyText: "",
    additional_data: undefined,
    request_id: undefined,
  });
}

const rateLimited = (retryAfter?: string) => apiError(429, APIErrorCode.RateLimited, retryAfter);
const unavailable = () => apiError(503, APIErrorCode.ServiceUnavailable);
const overloaded = () => apiError(529, APIErrorCode.ServiceOverload);

/** An SDK client whose users.retrieve (a read) and comments.create (a write) fail with `failures` first. */
function setup(failures: APIResponseError[], options: { sleep?: (ms: number) => Promise<void>; maxConcurrent?: number } = {}) {
  const attempts = { read: 0, write: 0 };
  const queue = [...failures];
  const next = <T>(kind: "read" | "write", value: T) => {
    attempts[kind]++;
    const failure = queue.shift();
    return failure ? Promise.reject(failure) : Promise.resolve(value);
  };
  const client = {
    users: { retrieve: () => next("read", { id: "u1", name: "Alice", type: "person" }) },
    comments: { create: () => next("write", { id: "c1" }) },
  };
  const slept: number[] = [];
  const api = new SdkNotionApi("token", {
    client: client as unknown as Client,
    maxConcurrent: options.maxConcurrent,
    sleep:
      options.sleep ??
      (async (ms) => {
        slept.push(ms);
      }),
  });
  const write = () => api.createComment({ pageId: "p1", richText: [], displayName: "Alice" });
  return { api, attempts, slept, write };
}

describe("Notion retries", () => {
  test("a rate limit of at most 2 s is waited out once, for reads and writes alike", async () => {
    const read = setup([rateLimited("1")]);
    expect(await read.api.retrieveUser("u1")).toMatchObject({ name: "Alice" });
    expect(read.slept).toEqual([1000]);

    const write = setup([rateLimited("2")]);
    expect(await write.write()).toEqual({ id: "c1" });
    expect(write.slept).toEqual([2000]);

    const twice = setup([rateLimited("1"), rateLimited("1")]);
    await expect(twice.api.retrieveUser("u1")).rejects.toThrow(NotionRequestError);
    expect(twice.attempts.read).toBe(2);
  });

  test("a longer or unstated rate limit fails at once, saying when to retry", async () => {
    const long = setup([rateLimited("5")]);
    const error = await long.api.retrieveUser("u1").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 5000 });
    expect(long.slept).toEqual([]);
    expect(String(toToolError(error))).toContain("Notion rate limit reached; retry in about 5 s.");

    const unstated = setup([rateLimited()]);
    const vague = await unstated.api.retrieveUser("u1").catch((caught: unknown) => caught);
    expect(unstated.slept).toEqual([]);
    expect(String(toToolError(vague))).toContain("retry in a moment");
  });

  test("server failures are retried for reads only, since a write may have been applied", async () => {
    const read = setup([unavailable(), overloaded(), unavailable()]);
    expect(await read.api.retrieveUser("u1")).toMatchObject({ name: "Alice" });
    expect(read.slept).toEqual([1000, 2000, 4000]);

    const exhausted = setup([unavailable(), unavailable(), unavailable(), unavailable()]);
    await expect(exhausted.api.retrieveUser("u1")).rejects.toMatchObject({ status: 503 });
    expect(exhausted.attempts.read).toBe(4);

    for (const failure of [unavailable(), overloaded()]) {
      const write = setup([failure]);
      await expect(write.write()).rejects.toMatchObject({ status: failure.status });
      expect(write.attempts.write).toBe(1);
      expect(write.slept).toEqual([]);
    }
  });

  test("waiting to retry does not hold a slot of the shared concurrency cap", async () => {
    let wake = () => {};
    const { api, attempts } = setup([rateLimited("1")], {
      maxConcurrent: 1,
      sleep: () => new Promise((resolve) => (wake = resolve)),
    });
    const first = api.retrieveUser("u1");
    await Bun.sleep(0);
    // With a single slot, this would never run if the waiting request kept it.
    expect(await api.retrieveUser("u1")).toMatchObject({ name: "Alice" });
    expect(attempts.read).toBe(2);
    wake();
    expect(await first).toMatchObject({ name: "Alice" });
  });
});
