import { describe, expect, it } from "vitest";
import { normalizeAsks, simulateFill, type BookLevel } from "./book-fill";

/** The FURIA vs G2 ask ladder, verbatim from a live CLOB book. */
const REAL_ASKS: BookLevel[] = [
  { price: 0.58, size: 56_619.1 },
  { price: 0.59, size: 46_501.9 },
  { price: 0.6, size: 3_599.3 },
  { price: 0.61, size: 7_046.1 },
];

describe("simulateFill", () => {
  it("fills a small stake entirely at the best ask on a deep book", () => {
    const result = simulateFill(REAL_ASKS, 1);
    expect(result.averagePrice).toBeCloseTo(0.58, 10);
    expect(result.slippagePoints).toBeCloseTo(0, 10);
    expect(result.levelsConsumed).toBe(1);
    expect(result.unfilledUsd).toBe(0);
  });

  it("reports the dollars resting at the best ask, which the spread hides", () => {
    // 0.58 x 56,619 shares is ~$32.8k. A one-cent spread over $12 is a different market.
    expect(simulateFill(REAL_ASKS, 1).bestAskDepthUsd).toBeCloseTo(32_839.08, 1);
  });

  it("walks into deeper levels once the top one is exhausted", () => {
    // Top level holds ~$32.8k, so $40k has to reach the second.
    const result = simulateFill(REAL_ASKS, 40_000);
    expect(result.levelsConsumed).toBe(2);
    expect(result.averagePrice as number).toBeGreaterThan(0.58);
    expect(result.averagePrice as number).toBeLessThan(0.59);
    expect(result.worstPrice).toBe(0.59);
    expect(result.slippagePoints as number).toBeGreaterThan(0);
  });

  it("exposes a thin book where the quote is decoration", () => {
    // The shape that matters: a tight spread with nothing behind it.
    const thin: BookLevel[] = [
      { price: 0.5, size: 24 }, // $12
      { price: 0.72, size: 500 },
    ];
    const result = simulateFill(thin, 50);
    expect(result.bestAskDepthUsd).toBeCloseTo(12, 6);
    expect(result.levelsConsumed).toBe(2);
    // A 50-dollar order pays far above the quoted 50c.
    expect(result.averagePrice as number).toBeGreaterThan(0.6);
    expect(result.slippagePoints as number).toBeGreaterThan(10);
  });

  it("reports the shortfall when the book cannot absorb the order", () => {
    const result = simulateFill([{ price: 0.5, size: 10 }], 100);
    expect(result.filledUsd).toBeCloseTo(5, 6);
    expect(result.unfilledUsd).toBeCloseTo(95, 6);
    expect(result.shares).toBeCloseTo(10, 6);
  });

  it("spends the budget rather than filling a share count", () => {
    // $10 at 50c is 20 shares, not 10.
    const result = simulateFill([{ price: 0.5, size: 1000 }], 10);
    expect(result.shares).toBeCloseTo(20, 10);
    expect(result.filledUsd).toBeCloseTo(10, 10);
  });

  it("sorts an unsorted ladder before walking it", () => {
    const scrambled: BookLevel[] = [
      { price: 0.7, size: 100 },
      { price: 0.5, size: 100 },
      { price: 0.6, size: 100 },
    ];
    expect(simulateFill(scrambled, 1).averagePrice).toBeCloseTo(0.5, 10);
  });

  it("returns an empty result rather than NaN for a missing or empty book", () => {
    const empty = simulateFill([], 1);
    expect(empty.averagePrice).toBeNull();
    expect(empty.shares).toBe(0);
    expect(empty.unfilledUsd).toBe(1);

    const zeroStake = simulateFill(REAL_ASKS, 0);
    expect(zeroStake.averagePrice).toBeNull();
    expect(Number.isFinite(zeroStake.totalAskDepthUsd)).toBe(true);
  });
});

describe("normalizeAsks", () => {
  it("parses the CLOB's decimal strings", () => {
    expect(normalizeAsks([{ price: "0.58", size: "100" }])).toEqual([{ price: 0.58, size: 100 }]);
  });

  it("discards levels that cannot be traded", () => {
    const result = normalizeAsks([
      { price: "0.58", size: "100" },
      { price: "0", size: "100" },
      { price: "1", size: "100" },
      { price: "0.5", size: "0" },
      { price: "abc", size: "100" },
      { price: "0.4", size: null },
    ]);
    expect(result).toEqual([{ price: 0.58, size: 100 }]);
  });

  it("returns levels cheapest first", () => {
    const result = normalizeAsks([
      { price: "0.7", size: "1" },
      { price: "0.5", size: "1" },
    ]);
    expect(result.map((l) => l.price)).toEqual([0.5, 0.7]);
  });
});
