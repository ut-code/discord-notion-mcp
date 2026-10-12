import { describe, expect, test } from "bun:test";
import { createLimiter } from "../../src/lib/server/lib/limiter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createLimiter", () => {
  test("runs at most `max` tasks at once and hands each freed slot to the next waiter in order", async () => {
    const limit = createLimiter(2);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        started.push(index);
        await gate.promise;
        active--;
        return index;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2]!.resolve();
    gates[3]!.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  test("a failing task releases its slot", async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await limit(async () => "next")).toBe("next");
  });
});
