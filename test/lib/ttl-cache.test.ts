import { describe, expect, test } from "bun:test";
import { TtlCache } from "../../src/lib/server/lib/ttl-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TtlCache", () => {
  test("concurrent loads of one key share a single in-flight promise", async () => {
    const cache = new TtlCache<string, number>(1000, () => 0);
    const gate = deferred<number>();
    let loads = 0;
    const loader = () => {
      loads++;
      return gate.promise;
    };
    const first = cache.getOrLoad("k", loader);
    const second = cache.getOrLoad("k", loader);
    gate.resolve(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
    expect(loads).toBe(1);
    expect(await cache.getOrLoad("k", loader)).toBe(7);
    expect(loads).toBe(1);
  });

  test("entries expire after the TTL and are loaded again", async () => {
    let now = 0;
    const cache = new TtlCache<string, number>(1000, () => now);
    let loads = 0;
    const loader = async () => ++loads;
    expect(await cache.getOrLoad("k", loader)).toBe(1);
    now = 999;
    expect(cache.get("k")).toBe(1);
    now = 1000;
    expect(cache.get("k")).toBeUndefined();
    expect(await cache.getOrLoad("k", loader)).toBe(2);
  });

  test("a failed load is not cached and does not block later loads", async () => {
    const cache = new TtlCache<string, number>(1000, () => 0);
    await expect(cache.getOrLoad("k", async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await cache.getOrLoad("k", async () => 3)).toBe(3);
  });
});
