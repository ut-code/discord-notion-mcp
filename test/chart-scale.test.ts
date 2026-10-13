import { describe, expect, test } from "bun:test";
import { labelIndexes, niceScale } from "../src/lib/chart-scale";

describe("niceScale", () => {
  test("rounds up to a 1-2-5 step", () => {
    expect(niceScale(37)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
    expect(niceScale(6)).toEqual({ max: 6, ticks: [0, 2, 4, 6] });
    expect(niceScale(1234)).toEqual({ max: 1500, ticks: [0, 500, 1000, 1500] });
  });

  test("keeps integer steps for small counts", () => {
    expect(niceScale(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceScale(1)).toEqual({ max: 1, ticks: [0, 1] });
  });

  test("an empty chart still has an axis", () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe("labelIndexes", () => {
  test("labels the last day and every step back from it", () => {
    expect(labelIndexes(30, 8).map((label) => label.index)).toEqual([1, 5, 9, 13, 17, 21, 25, 29]);
  });

  test("narrow screens keep every other label, including the last", () => {
    const narrow = labelIndexes(30, 8).filter((label) => label.narrow);
    expect(narrow.map((label) => label.index)).toEqual([5, 13, 21, 29]);
  });

  test("short ranges label every day", () => {
    expect(labelIndexes(7, 8).map((label) => label.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
