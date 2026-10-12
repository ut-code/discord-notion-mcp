export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `max` tasks concurrently; extra tasks wait in FIFO order. */
export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot directly to the next waiter so the count never exceeds `max`.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
