import { systemClock, type Clock } from "./ttl-cache";

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  clock?: Clock;
}

/** Full buckets are dropped once this many keys are tracked (a full bucket equals no entry). */
const PRUNE_THRESHOLD = 1000;

/** In-memory token buckets, one per key; each call to `take` consumes one token. */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly clock: Clock;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerSecond / 1000;
    this.clock = options.clock ?? systemClock;
  }

  take(key: string): RateLimitDecision {
    const now = this.clock();
    if (this.buckets.size >= PRUNE_THRESHOLD) this.prune(now);
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const tokens = this.refilled(bucket, now);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.refillPerMs / 1000)) };
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return { ok: true };
  }

  private refilled(bucket: Bucket, now: number): number {
    return Math.min(this.capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.refillPerMs);
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now) >= this.capacity) this.buckets.delete(key);
    }
  }
}
