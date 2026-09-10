import { describe, expect, it } from "vitest";
import { analyzeEntryGap, entryGapBadge, weightedEntryPrice } from "./entry-gap";

describe("analyzeEntryGap — the worked examples from the spec", () => {
  it("31¢ elite entry vs 34¢ market is a +3¢ gap and rates GOOD", () => {
    const result = analyzeEntryGap(0.34, 0.31);
    expect(result.entryGap).toBeCloseTo(0.03, 10);
    expect(result.quality).toBe("GOOD");
    expect(result.score).toBeGreaterThan(70);
  });

  it("24¢ elite entry vs 61¢ market is a +37¢ gap and rates STALE", () => {
    const result = analyzeEntryGap(0.61, 0.24);
    expect(result.entryGap).toBeCloseTo(0.37, 10);
    expect(result.quality).toBe("STALE");
    expect(result.label).toMatch(/stale/i);
    expect(result.score).toBe(0);
  });

  it("21¢ entry vs 68¢ market — the headline case — is heavily discounted", () => {
    const result = analyzeEntryGap(0.68, 0.21);
    expect(result.entryGap).toBeCloseTo(0.47, 10);
    expect(result.quality).toBe("STALE");
    expect(result.score).toBe(0);
    expect(result.explanation).toMatch(/stale/i);
  });
});

describe("analyzeEntryGap — quality bands", () => {
  it("grades an aligned entry as GOOD", () => {
    expect(analyzeEntryGap(0.5, 0.5).quality).toBe("GOOD");
    expect(analyzeEntryGap(0.54, 0.5).quality).toBe("GOOD");
  });

  it("grades a moderate gap as FAIR", () => {
    expect(analyzeEntryGap(0.58, 0.5).quality).toBe("FAIR");
  });

  it("grades a large gap as POOR", () => {
    expect(analyzeEntryGap(0.65, 0.5).quality).toBe("POOR");
  });

  it("flags entering below elite entry separately rather than calling it great", () => {
    const result = analyzeEntryGap(0.3, 0.5);
    expect(result.quality).toBe("BETTER_THAN_ELITE");
    // Credited, but deliberately capped below a perfectly aligned entry.
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.explanation).toMatch(/not automatically an advantage/i);
  });

  it("score decreases monotonically as the price runs away from smart money", () => {
    const scores = [0.5, 0.55, 0.6, 0.65, 0.7].map(
      (price) => analyzeEntryGap(price, 0.5).score as number,
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });
});

describe("analyzeEntryGap — missing data", () => {
  it("returns UNKNOWN rather than a fabricated gap when there is no elite entry", () => {
    const result = analyzeEntryGap(0.5, null);
    expect(result.quality).toBe("UNKNOWN");
    expect(result.entryGap).toBeNull();
    expect(result.score).toBeNull();
    expect(result.label).toBe("Unavailable");
  });

  it("returns UNKNOWN when the current price is missing", () => {
    expect(analyzeEntryGap(null, 0.3).quality).toBe("UNKNOWN");
  });

  it("does not divide by a zero entry price", () => {
    const result = analyzeEntryGap(0.5, 0);
    expect(result.quality).toBe("UNKNOWN");
    expect(result.entryGapPct).toBeNull();
  });

  it("never emits NaN or Infinity", () => {
    const inputs: Array<[unknown, unknown]> = [
      [0.5, 0], [0, 0.5], [NaN, 0.5], [0.5, NaN], [null, null], [Infinity, 0.5],
    ];
    for (const [current, entry] of inputs) {
      const result = analyzeEntryGap(current, entry);
      for (const value of [result.entryGap, result.entryGapPct, result.score]) {
        if (value !== null) expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe("weightedEntryPrice", () => {
  it("weights entries by size × quality", () => {
    // A $900-weighted entry at 20¢ and a $100-weighted entry at 70¢ average to 25¢.
    const result = weightedEntryPrice([
      { avgPrice: 0.2, weight: 900 },
      { avgPrice: 0.7, weight: 100 },
    ]);
    expect(result).toBeCloseTo(0.25, 10);
  });

  it("ignores zero and negative weights instead of dividing by zero", () => {
    expect(weightedEntryPrice([{ avgPrice: 0.5, weight: 0 }])).toBeNull();
    expect(weightedEntryPrice([{ avgPrice: 0.5, weight: -10 }])).toBeNull();
  });

  it("returns null for an empty set", () => {
    expect(weightedEntryPrice([])).toBeNull();
  });

  it("skips entries with a missing price", () => {
    const result = weightedEntryPrice([
      { avgPrice: null, weight: 100 },
      { avgPrice: 0.4, weight: 100 },
    ]);
    expect(result).toBeCloseTo(0.4, 10);
  });

  it("handles a single trader", () => {
    expect(weightedEntryPrice([{ avgPrice: 0.33, weight: 1 }])).toBeCloseTo(0.33, 10);
  });
});

describe("entryGapBadge", () => {
  it("maps quality onto a tone", () => {
    expect(entryGapBadge(analyzeEntryGap(0.5, 0.5)).tone).toBe("good");
    expect(entryGapBadge(analyzeEntryGap(0.65, 0.5)).tone).toBe("warn");
    expect(entryGapBadge(analyzeEntryGap(0.9, 0.4)).tone).toBe("bad");
    expect(entryGapBadge(analyzeEntryGap(null, null)).tone).toBe("neutral");
  });
});
