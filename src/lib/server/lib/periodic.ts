/** Runs `task` now and then every `intervalMs` without keeping the process alive; returns a stop function. */
export function runPeriodically(task: () => void, intervalMs: number): () => void {
  task();
  const timer = setInterval(task, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
