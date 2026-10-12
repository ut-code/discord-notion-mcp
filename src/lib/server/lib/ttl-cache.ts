export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * In-memory TTL map. Concurrent loads for the same key share one in-flight promise.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock = systemClock,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
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
