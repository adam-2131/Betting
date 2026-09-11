import { describe, expect, it } from "vitest";
import {
  describeRelation,
  RELATION_GATE,
  SLICE_GATE,
  scoreVsClv,
  sliceByCategory,
  sliceByPrice,
  sliceByScore,
  type BetRecord,
} from "./breakdown";

function bet(overrides: Partial<BetRecord> = {}): BetRecord {
  return {
    entryPrice: 0.5,
    clvPoints: 2,
    horizonScore: 70,
    category: "SPORTS",
    won: null,
    pnl: null,
    stake: 1,
    ...overrides,
  };
}

function many(count: number, overrides: (i: number) => Partial<BetRecord>): BetRecord[] {
  return Array.from({ length: count }, (_, i) => bet(overrides(i)));
}

describe("descriptive slices", () => {
  it("withholds an average below the gate rather than showing one with a caveat", () => {
    // The whole design point: a caveat next to a number gets skimmed, a blank does not.
    const slices = sliceByPrice(many(SLICE_GATE - 1, () => ({ entryPrice: 0.5, clvPoints: 9 })));
    const band = slices.find((s) => s.label === "40–60¢");
    expect(band?.count).toBe(SLICE_GATE - 1);
    expect(band?.meanClv).toBeNull();
  });

  it("reports an average once the slice is big enough", () => {
    const slices = sliceByPrice(many(SLICE_GATE, () => ({ entryPrice: 0.5, clvPoints: 3 })));
    expect(slices.find((s) => s.label === "40–60¢")?.meanClv).toBeCloseTo(3, 6);
  });

  it("gates on MEASURED bets, not on logged ones", () => {
    // Ten bets where only three have closed is a three-bet sample, whatever the count says.
    const records = [
      ...many(3, () => ({ clvPoints: 5 })),
      ...many(7, () => ({ clvPoints: null })),
    ];
    const band = sliceByPrice(records).find((s) => s.label === "40–60¢");
    expect(band?.count).toBe(10);
    expect(band?.measured).toBe(3);
    expect(band?.meanClv).toBeNull();
  });

  it("puts each bet in exactly one price band", () => {
    const records = [
      bet({ entryPrice: 0.1 }),
      bet({ entryPrice: 0.3 }),
      bet({ entryPrice: 0.5 }),
      bet({ entryPrice: 0.7 }),
      bet({ entryPrice: 0.95 }),
    ];
    const slices = sliceByPrice(records);
    expect(slices.reduce((a, s) => a + s.count, 0)).toBe(5);
    expect(slices.every((s) => s.count === 1)).toBe(true);
  });

  it("includes a price of exactly 1 rather than dropping it", () => {
    expect(
      sliceByPrice([bet({ entryPrice: 1 })]).find((s) => s.label === "80¢ and up")?.count,
    ).toBe(1);
  });

  it("slices by score band and excludes unscored bets", () => {
    const records = [
      bet({ horizonScore: 30 }),
      bet({ horizonScore: 50 }),
      bet({ horizonScore: 85 }),
      bet({ horizonScore: null }),
    ];
    const slices = sliceByScore(records);
    expect(slices.reduce((a, s) => a + s.count, 0)).toBe(3);
  });

  it("orders categories by how much you actually bet them", () => {
    const records = [
      ...many(3, () => ({ category: "SPORTS" })),
      ...many(5, () => ({ category: "POLITICS" })),
    ];
    expect(sliceByCategory(records).map((s) => s.label)).toEqual(["POLITICS", "SPORTS"]);
  });

  it("counts settled results per slice", () => {
    const records = [bet({ won: true }), bet({ won: false }), bet({ won: null })];
    const band = sliceByPrice(records).find((s) => s.label === "40–60¢");
    expect(band?.wins).toBe(1);
    expect(band?.losses).toBe(1);
  });
});

describe("scoreVsClv — the one pre-specified test", () => {
  it("refuses to compute below the gate", () => {
    const relation = scoreVsClv(many(RELATION_GATE - 1, (i) => ({ horizonScore: 50 + i, clvPoints: i })));
    expect(relation.verdict).toBe("TOO_FEW");
    expect(relation.correlation).toBeNull();
  });

  it("finds a positive relationship when a higher score really did buy better", () => {
    const records = many(30, (i) => ({ horizonScore: 40 + i, clvPoints: -5 + i * 0.4 }));
    const relation = scoreVsClv(records);
    expect(relation.correlation as number).toBeGreaterThan(0.9);
    expect(relation.low as number).toBeGreaterThan(0);
    expect(relation.verdict).toBe("POSITIVE");
  });

  it("finds a negative relationship when following the score bought worse", () => {
    const records = many(30, (i) => ({ horizonScore: 40 + i, clvPoints: 5 - i * 0.4 }));
    const relation = scoreVsClv(records);
    expect(relation.high as number).toBeLessThan(0);
    expect(relation.verdict).toBe("NEGATIVE");
  });

  it("declines to call noise a relationship", () => {
    // Alternating CLV against rising score: no real signal.
    const records = many(20, (i) => ({ horizonScore: 40 + i, clvPoints: i % 2 === 0 ? 4 : -4 }));
    const relation = scoreVsClv(records);
    expect(relation.verdict).toBe("NO_RELATION");
    expect((relation.low as number) < 0 && (relation.high as number) > 0).toBe(true);
  });

  it("returns TOO_FEW when every bet has the same score, since nothing varies", () => {
    const records = many(20, (i) => ({ horizonScore: 70, clvPoints: i }));
    expect(scoreVsClv(records).verdict).toBe("TOO_FEW");
  });

  it("ignores bets missing either half of the pair", () => {
    const records = [
      ...many(20, (i) => ({ horizonScore: 40 + i, clvPoints: -5 + i * 0.4 })),
      ...many(10, () => ({ horizonScore: null })),
      ...many(10, () => ({ clvPoints: null })),
    ];
    expect(scoreVsClv(records).n).toBe(20);
  });

  it("produces an interval that is asymmetric in r, as Fisher's z requires", () => {
    const records = many(20, (i) => ({ horizonScore: 40 + i, clvPoints: -5 + i * 0.45 }));
    const relation = scoreVsClv(records);
    const r = relation.correlation as number;
    // With r near 1 the interval must be squeezed above and wider below.
    expect((relation.high as number) - r).toBeLessThan(r - (relation.low as number));
  });
});

describe("describeRelation", () => {
  it("says how many more are needed below the gate", () => {
    const text = describeRelation(scoreVsClv(many(4, (i) => ({ horizonScore: 50 + i }))));
    expect(text).toContain(`${RELATION_GATE - 4} more`);
  });

  it("states plainly when the ranking is making prices worse", () => {
    const text = describeRelation(scoreVsClv(many(30, (i) => ({ horizonScore: 40 + i, clvPoints: 5 - i * 0.4 }))));
    expect(text).toContain("WORSE");
  });

  it("does not claim anything when the interval spans zero", () => {
    const text = describeRelation(
      scoreVsClv(many(20, (i) => ({ horizonScore: 40 + i, clvPoints: i % 2 === 0 ? 4 : -4 }))),
    );
    expect(text).toContain("not yet shown");
  });
});
