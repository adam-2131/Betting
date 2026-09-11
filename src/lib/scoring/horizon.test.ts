import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_CONFIG } from "./config";
import { computeHorizonScore, effectiveEntryPrice, type HorizonInput } from "./horizon";

const NOW = new Date("2026-09-11T12:00:00Z");
const SLIPPAGE = DEFAULT_SCORING_CONFIG.shortHorizon.slippageAllowance;

/** A healthy, liquid, well-backed position resolving in three days. Overridden per test. */
function input(overrides: Partial<HorizonInput> = {}): HorizonInput {
  return {
    currentPrice: 0.5,
    bestAsk: 0.51,
    spread: 0.02,
    liquidity: 50_000,
    modelMid: 0.58,
    modelLow: 0.54,
    endDate: new Date("2026-09-14T12:00:00Z"), // +3 days
    settlesAt: null,
    settlementTiming: "STATED",
    clarityScore: 80,
    consensusScore: 70,
    qualifiedTraders: 4,
    now: NOW,
    ...overrides,
  };
}

describe("effectiveEntryPrice — you buy at the ask, not the mid", () => {
  it("uses the quoted ask rather than the mid price", () => {
    // The mid is the fair value nobody transacts at. Over three days the difference is the trade.
    const price = effectiveEntryPrice(0.5, 0.51, 0.02, 0);
    expect(price).toBeCloseTo(0.51, 10);
  });

  it("reconstructs the ask from the mid and half the spread when no ask is quoted", () => {
    expect(effectiveEntryPrice(0.5, null, 0.04, 0)).toBeCloseTo(0.52, 10);
  });

  it("falls back to the mid when neither ask nor spread is available", () => {
    expect(effectiveEntryPrice(0.5, null, null, 0)).toBeCloseTo(0.5, 10);
  });

  it("adds the slippage allowance on top of the quote", () => {
    expect(effectiveEntryPrice(0.5, 0.5, 0.01, 0.02)).toBeCloseTo(0.51, 10);
  });

  it("returns null when the resulting entry has no upside left", () => {
    // A 99¢ ask plus slippage crosses $1: there is nothing to win.
    expect(effectiveEntryPrice(0.99, 0.999, 0.01, 0.02)).toBeNull();
  });

  it("returns null rather than NaN when there is no price at all", () => {
    expect(effectiveEntryPrice(null, null, null, SLIPPAGE)).toBeNull();
    expect(effectiveEntryPrice(0, null, null, SLIPPAGE)).toBeNull();
  });

  it("ignores a nonsensical quoted ask and falls back", () => {
    // An ask of 0 or >=1 is not a real quote.
    expect(effectiveEntryPrice(0.5, 0, 0.02, 0)).toBeCloseTo(0.51, 10);
    expect(effectiveEntryPrice(0.5, 1.4, 0.02, 0)).toBeCloseTo(0.51, 10);
  });
});

describe("return per day of capital", () => {
  it("ranks a fast small edge above a slow large one", () => {
    // THE WHOLE POINT OF THIS MODULE. The opportunity score would rank these the other way round.
    const fast = computeHorizonScore(
      input({ modelMid: 0.55, modelLow: 0.52, endDate: new Date("2026-09-14T12:00:00Z") }),
    );
    const slow = computeHorizonScore(
      input({ modelMid: 0.7, modelLow: 0.64, endDate: new Date("2027-05-11T12:00:00Z") }),
    );

    expect(fast.returnPerDay).not.toBeNull();
    expect(slow.returnPerDay).not.toBeNull();
    expect(fast.returnPerDay as number).toBeGreaterThan(slow.returnPerDay as number);
    expect(fast.score).toBeGreaterThan(slow.score);
  });

  it("computes return per day from the effective price, not the mid", () => {
    const result = computeHorizonScore(
      input({ currentPrice: 0.5, bestAsk: 0.51, modelMid: 0.58, modelLow: 0.54 }),
    );

    const expectedEntry = 0.51 * (1 + SLIPPAGE);
    expect(result.effectivePrice).toBeCloseTo(expectedEntry, 10);

    const expectedRoc = (0.58 - expectedEntry) / expectedEntry;
    expect(result.expectedReturnOnCapital).toBeCloseTo(expectedRoc, 10);
    expect(result.returnPerDay).toBeCloseTo(expectedRoc / 3, 10);
  });

  it("floors the denominator at one day so near-expiry markets cannot diverge", () => {
    // Without the floor a 3% edge over two hours computes to 36% per day and would pin the top of
    // the list purely on arithmetic.
    const twoHours = computeHorizonScore(
      input({ endDate: new Date("2026-09-11T14:00:00Z") }),
    );

    expect(twoHours.hoursToSettlement).toBeCloseTo(2, 6);
    expect(twoHours.capitalDays).toBe(1);
    expect(twoHours.capitalDaysFloored).toBe(true);
    // Return per day equals the raw return on capital, not twelve times it.
    expect(twoHours.returnPerDay).toBeCloseTo(twoHours.expectedReturnOnCapital as number, 10);
  });

  it("does not floor a horizon already longer than a day", () => {
    const result = computeHorizonScore(input());
    expect(result.capitalDays).toBeCloseTo(3, 6);
    expect(result.capitalDaysFloored).toBe(false);
  });

  it("prefers a scheduled settlement over the stated close date", () => {
    // Sports: endDate is kickoff, so settlement is later and the hold is longer than endDate says.
    const result = computeHorizonScore(
      input({
        endDate: new Date("2026-09-13T17:00:00Z"),
        settlesAt: new Date("2026-09-13T20:12:00Z"),
        settlementTiming: "SCHEDULED",
      }),
    );
    // 2026-09-11T12:00 -> 2026-09-13T20:12 is 56.2 hours.
    expect(result.hoursToSettlement).toBeCloseTo(56.2, 5);
  });
});

describe("edge netted against execution", () => {
  it("reports what fraction of the theoretical edge survives the spread", () => {
    const result = computeHorizonScore(
      input({ currentPrice: 0.5, bestAsk: 0.54, spread: 0.08, modelMid: 0.58 }),
    );

    // Gross edge is 8 points against the mid; entry at ~54.5¢ leaves ~3.5.
    expect(result.grossEdgePoints).toBeCloseTo(8, 6);
    expect(result.netEdgePoints as number).toBeLessThan(4);
    expect(result.edgeRetention as number).toBeLessThan(0.5);
  });

  it("penalises hard when the spread consumes the whole edge", () => {
    // A 96¢ spread is not hypothetical — that is what an unquoted sports prop book looks like.
    const eaten = computeHorizonScore(
      input({ currentPrice: 0.5, bestAsk: 0.62, spread: 0.24, modelMid: 0.58 }),
    );

    expect(eaten.netEdgePoints as number).toBeLessThan(0);
    expect(eaten.penalties.map((p) => p.key)).toContain("negative-net-edge");
    expect(eaten.verdict).toMatch(/spread|underpricing/i);
  });

  it("keeps a wide-spread trade below an identical tight-spread one", () => {
    const tight = computeHorizonScore(input({ bestAsk: 0.505, spread: 0.01 }));
    const wide = computeHorizonScore(input({ bestAsk: 0.55, spread: 0.1 }));
    expect(tight.score).toBeGreaterThan(wide.score);
  });
});

describe("downside testing against the model's own uncertainty band", () => {
  it("scores a position that stays positive at the low end above one that does not", () => {
    const robust = computeHorizonScore(input({ modelMid: 0.58, modelLow: 0.56 }));
    const fragile = computeHorizonScore(input({ modelMid: 0.58, modelLow: 0.48 }));

    expect(robust.downsideReturnOnCapital as number).toBeGreaterThan(0);
    expect(fragile.downsideReturnOnCapital as number).toBeLessThan(0);
    expect(robust.score).toBeGreaterThan(fragile.score);
  });

  it("says plainly in the verdict when the edge depends on the estimate being right", () => {
    const fragile = computeHorizonScore(input({ modelMid: 0.58, modelLow: 0.48 }));
    expect(fragile.verdict).toContain("low end");
  });
});

describe("penalties and refusals", () => {
  it("penalises a missing resolution date instead of inventing a horizon", () => {
    const result = computeHorizonScore(input({ endDate: null, settlesAt: null }));

    expect(result.hoursToSettlement).toBeNull();
    expect(result.capitalDays).toBeNull();
    expect(result.returnPerDay).toBeNull();
    expect(result.penalties.map((p) => p.key)).toContain("unknown-horizon");
    expect(result.verdict).toContain("No resolution date");
  });

  it("treats an end date already in the past as unknown rather than negative", () => {
    const result = computeHorizonScore(input({ endDate: new Date("2026-09-01T12:00:00Z") }));
    expect(result.hoursToSettlement).toBeNull();
    expect(result.returnPerDay).toBeNull();
  });

  it("penalises longshot pricing where the payout rarely arrives", () => {
    const result = computeHorizonScore(
      input({ currentPrice: 0.05, bestAsk: 0.06, modelMid: 0.09, modelLow: 0.07 }),
    );
    expect(result.penalties.map((p) => p.key)).toContain("longshot");
  });

  it("penalises a book too thin to fill", () => {
    const result = computeHorizonScore(input({ liquidity: 200 }));
    expect(result.penalties.map((p) => p.key)).toContain("thin-book");
  });

  it("penalises a side with almost no smart-money backing", () => {
    const result = computeHorizonScore(input({ qualifiedTraders: 1 }));
    expect(result.penalties.map((p) => p.key)).toContain("insufficient-sample");
  });

  it("never produces NaN or Infinity from degenerate input", () => {
    const result = computeHorizonScore(
      input({
        currentPrice: null,
        bestAsk: null,
        spread: null,
        liquidity: null,
        modelMid: null,
        modelLow: null,
        endDate: null,
        settlesAt: null,
        settlementTiming: "UNKNOWN",
        clarityScore: null,
        consensusScore: null,
        qualifiedTraders: 0,
      }),
    );

    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    for (const value of [
      result.returnPerDay,
      result.expectedReturnOnCapital,
      result.effectivePrice,
      result.edgeRetention,
    ]) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });

  it("keeps the score inside 0-100 when every penalty fires at once", () => {
    const result = computeHorizonScore(
      input({
        currentPrice: 0.04,
        bestAsk: 0.09,
        spread: 0.1,
        liquidity: 50,
        modelMid: 0.05,
        modelLow: 0.02,
        endDate: null,
        settlesAt: null,
        settlementTiming: "UNKNOWN",
        clarityScore: 10,
        consensusScore: 5,
        qualifiedTraders: 0,
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe("score composition stays auditable", () => {
  it("exposes every component with its weight and contribution", () => {
    const result = computeHorizonScore(input());
    const keys = result.components.map((c) => c.key);

    expect(keys).toEqual([
      "capitalEfficiency",
      "downsideTested",
      "signalConfidence",
      "executability",
      "settlementCertainty",
    ]);
    for (const component of result.components) {
      expect(component.detail).toBeTruthy();
      expect(Number.isFinite(component.contribution)).toBe(true);
    }
  });

  it("weights sum to 100 so the base score is a real percentage", () => {
    const total = Object.values(DEFAULT_SCORING_CONFIG.shortHorizon.weights).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBe(100);
  });
});
