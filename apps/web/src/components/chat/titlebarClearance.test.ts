import { describe, expect, it } from "vite-plus/test";

import { titlebarOverlap } from "./titlebarClearance";

const rect = (left: number, right: number, top = 0, bottom = 52) => ({
  left,
  right,
  top,
  bottom,
  width: right - left,
});

describe("titlebarOverlap", () => {
  const row = rect(300, 1000);

  it("is how far the row reaches under the leftmost controls on its line", () => {
    expect(titlebarOverlap(row, [rect(860, 990)])).toBe(140);
    expect(titlebarOverlap(row, [rect(860, 990), rect(940, 990)])).toBe(140);
  });

  it("ignores controls beside the row, below it, or hidden", () => {
    expect(titlebarOverlap(row, [rect(1010, 1100)])).toBe(0);
    expect(titlebarOverlap(row, [rect(860, 990, 60, 112)])).toBe(0);
    expect(titlebarOverlap(row, [rect(990, 990)])).toBe(0);
  });
});
