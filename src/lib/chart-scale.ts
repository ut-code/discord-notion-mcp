/** Rounds `max` up to a 1-2-5 step so the y axis shows about `count` evenly spaced integer ticks. */
export function niceScale(max: number, count = 4): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(
    1,
    [1, 2, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= raw)!,
  );
  const top = Math.ceil(max / step) * step;
  return { max: top, ticks: Array.from({ length: top / step + 1 }, (_, index) => index * step) };
}

/**
 * The x labels: at most `limit`, counted back from the last bar so the latest day is always
 * labelled. `narrow` marks every other one, the subset kept on narrow screens.
 */
export function labelIndexes(length: number, limit: number): Array<{ index: number; narrow: boolean }> {
  const step = Math.max(1, Math.ceil(length / limit));
  return Array.from({ length }, (_, index) => index)
    .filter((index) => (length - 1 - index) % step === 0)
    .map((index) => ({ index, narrow: (length - 1 - index) % (2 * step) === 0 }));
}
