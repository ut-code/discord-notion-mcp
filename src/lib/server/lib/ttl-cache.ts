export type Clock = () => number;

/**
 * Milliseconds on a monotonic clock. Unlike Date.now(), it never jumps when the system time is
 * set, so an expiry or a refill stays as long as intended.
 */
export const systemClock: Clock = () => performance.now();

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * In-memory TTL map. Concurrent loads for the same key share one in-flight promise.
 * With `maxEntries`, the least recently stored entries are dropped first.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock = systemClock,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  private set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
  }

  async getOrLoad(key: K, loader: () => Promise<V>): Promise<V> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.clock()) return entry.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = loader()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }
}
