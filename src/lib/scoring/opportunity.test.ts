import { Category } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { computeConsensus, type ConsensusHolder, type ConsensusMarketContext } from "./consensus";
import {
  computeModelEstimate,
  computeOpportunityScore,
  type OpportunityMarketInput,
} from "./opportunity";

const NOW = new Date("2026-09-01T00:00:00Z");
const HOUR = 3_600_000;

function holder(overrides: Partial<ConsensusHolder> = {}): ConsensusHolder {
  return {
    traderId: `t-${Math.random().toString(36).slice(2)}`,
    wallet: `0x${Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40)}`,
    displayName: "Trader",
    smartScore: 82,
    categorySkill: 75,
    sizeUsd: 50_000,
    avgPrice: 0.29,
    openedAt: new Date(NOW.getTime() - 36 * HOUR),
    typicalPositionUsd: 40_000,
    recentNetUsd: 8_000,
    likelyBot: false,
    ...overrides,
  };
}

const consensusContext: ConsensusMarketContext = {
  category: Category.POLITICS,
  currentPrice: 0.32,
  liquidity: 1_400_000,
  spread: 0.012,
  now: NOW,
};

function marketInput(overrides: Partial<OpportunityMarketInput> = {}): OpportunityMarketInput {
  return {
    conditionId: "0xtest",
    question: "Will Example Candidate win?",
    category: Category.POLITICS,
    outcomeIndex: 0,
    outcomeLabel: "YES",
    currentPrice: 0.32,
    liquidity: 1_400_000,
    spread: 0.012,
    volume24hr: 250_000,
    endDate: new Date(NOW.getTime() + 60 * 24 * HOUR),
    clarityScore: 82,
    clarityFlags: [],
    hasBotContributors: false,
    hoursSinceLastActivity: 6,
    ...overrides,
  };
}

function strongConsensus() {
  return computeConsensus(
    Array.from({ length: 7 }, () => holder()),
    [holder({ smartScore: 66, sizeUsd: 10_000 })],
    consensusContext,
  );
}

describe("computeOpportunityScore", () => {
  it("exposes all seven weighted components", () => {
    const result = computeOpportunityScore(marketInput(), strongConsensus(), NOW);
    expect(result.components.map((c) => c.key)).toEqual([
      "consensus", "traderQuality", "entryQuality", "liquidity", "execution", "recency", "clarity",
    ]);
    const totalWeight = result.components.reduce((acc, c) => acc + c.weight, 0);
    expect(totalWeight).toBe(100);
  });

  it("scores a strong, well-priced, liquid opportunity highly", () => {
    const result = computeOpportunityScore(marketInput(), strongConsensus(), NOW);
    expect(result.score).toBeGreaterThan(60);
    expect(result.entryGap.quality).toBe("GOOD");
  });

  it("ranks an identical signal lower once the price has run away from smart money", () => {
    const aligned = computeOpportunityScore(marketInput(), strongConsensus(), NOW);

    const chasedContext = { ...consensusContext, currentPrice: 0.68 };
    const chasedConsensus = computeConsensus(
      Array.from({ length: 7 }, () => holder({ avgPrice: 0.21 })),
      [holder({ smartScore: 66, sizeUsd: 10_000 })],
      chasedContext,
    );
    const chased = computeOpportunityScore(
      marketInput({ currentPrice: 0.68 }),
      chasedConsensus,
      NOW,
    );

    expect(chased.score).toBeLessThan(aligned.score);
    expect(chased.penalties.find((p) => p.key === "entry-gap")).toBeDefined();
    expect(chased.entryGap.quality).toBe("STALE");
  });

  it("penalises low liquidity, wide spreads and imminent resolution", () => {
    const result = computeOpportunityScore(
      marketInput({
        liquidity: 500,
        spread: 0.12,
        endDate: new Date(NOW.getTime() + 2 * HOUR),
      }),
      strongConsensus(),
      NOW,
    );
    const keys = result.penalties.map((p) => p.key);
    expect(keys).toContain("low-liquidity");
    expect(keys).toContain("wide-spread");
    expect(keys).toContain("short-time");
  });

  it("penalises stale smart-money activity and ambiguous resolution", () => {
    const result = computeOpportunityScore(
      marketInput({
        hoursSinceLastActivity: 24 * 40,
        clarityScore: 30,
        clarityFlags: ["Resolution depends on discretion or judgement"],
      }),
      strongConsensus(),
      NOW,
    );
    const keys = result.penalties.map((p) => p.key);
    expect(keys).toContain("stale");
    expect(keys).toContain("ambiguous");
  });

  it("penalises an insufficient trader sample", () => {
    const thin = computeConsensus([holder()], [], consensusContext);
    const result = computeOpportunityScore(marketInput(), thin, NOW);
    expect(result.penalties.find((p) => p.key === "insufficient-sample")).toBeDefined();
  });

  it("attaches payout figures for a $1 stake", () => {
    const result = computeOpportunityScore(marketInput({ currentPrice: 0.32 }), strongConsensus(), NOW);
    expect(result.payout.shares).toBeCloseTo(3.125, 6);
    expect(result.payout.grossPayout).toBeCloseTo(3.125, 6);
    expect(result.payout.profit).toBeCloseTo(2.125, 6);
    expect(result.payout.lossIfWrong).toBe(1);
  });

  it("always provides reasons for and against", () => {
    const result = computeOpportunityScore(marketInput(), strongConsensus(), NOW);
    expect(result.reasonsFor.length).toBeGreaterThan(0);
    expect(result.reasonsAgainst.length).toBeGreaterThan(0);
    // The standing caveat that smart traders are still often wrong must always be present.
    expect(result.reasonsAgainst.join(" ")).toMatch(/frequently wrong/i);
  });

  it("never uses hype language", () => {
    const result = computeOpportunityScore(marketInput(), strongConsensus(), NOW);
    const prose = [
      ...result.reasonsFor,
      ...result.reasonsAgainst,
      ...result.riskReasons,
      result.entryGap.explanation,
      result.modelEstimate.caveat,
      ...result.components.map((c) => c.detail ?? ""),
      ...result.penalties.map((p) => p.detail),
    ].join(" ").toLowerCase();

    // Matched in affirmative position only. Disclaiming these terms ("not a guaranteed edge") is
    // exactly the tone we want, so a bare substring check would punish the right behaviour.
    const hypePatterns: Array<[string, RegExp]> = [
      ["guaranteed", /(?<!\bnot a )(?<!\bno )(?<!\bnever )guaranteed/],
      ["easy money", /easy money/],
      ["sure bet", /(?<!\bnot a )sure bet/],
      ["can't lose", /can'?t lose/],
      ["cannot lose", /cannot lose/],
      ["risk-free", /(?<!\bnot )risk[- ]free/],
      ["free money", /free money/],
      ["lock", /\block\b/],
      ["no-brainer", /no[- ]brainer/],
    ];

    for (const [label, pattern] of hypePatterns) {
      expect(pattern.test(prose), `should not use "${label}" affirmatively`).toBe(false);
    }
  });

  it("assigns higher risk to longshots and thin markets", () => {
    const longshot = computeOpportunityScore(
      marketInput({ currentPrice: 0.05, liquidity: 3_000 }),
      strongConsensus(),
      NOW,
    );
    const solid = computeOpportunityScore(marketInput({ currentPrice: 0.48 }), strongConsensus(), NOW);
    expect(["HIGH", "VERY HIGH"]).toContain(longshot.riskLevel);
    expect(solid.riskLevel).toBe("LOW");
  });
});

describe("computeModelEstimate", () => {
  it("returns a range around a midpoint that leans toward smart money but stays near the market", () => {
    const estimate = computeModelEstimate(0.42, strongConsensus());
    expect(estimate.mid).not.toBeNull();
    expect(estimate.mid!).toBeGreaterThan(0.42);
    expect(estimate.low!).toBeLessThan(estimate.mid!);
    expect(estimate.high!).toBeGreaterThan(estimate.mid!);
    // Hard cap on how far it may stray from the market price.
    expect(estimate.mid! - 0.42).toBeLessThanOrEqual(0.12 + 1e-9);
  });

  it("always carries the caveat that it is not a guaranteed edge", () => {
    const estimate = computeModelEstimate(0.42, strongConsensus());
    expect(estimate.caveat).toMatch(/not a guaranteed edge/i);
    expect(estimate.caveat).toMatch(/model estimate/i);
  });

  it("declines to estimate with no qualified traders", () => {
    const empty = computeConsensus([], [], consensusContext);
    const estimate = computeModelEstimate(0.42, empty);
    expect(estimate.mid).toBeNull();
    expect(estimate.edgePoints).toBeNull();
  });

  it("moves DOWN when the consensus is below neutral, not only up", () => {
    // THE DEFECT THIS REPLACED. The shift was clamped at zero, so the estimate could only ever
    // rise and every side examined came back underpriced — on live data, 97 of 97 positive-edge
    // sides claimed the outcome was likelier than the market said and none claimed the reverse.
    // Both sides of a binary market cannot be cheap.
    const weak = { ...strongConsensus(), score: 25 };
    const estimate = computeModelEstimate(0.42, weak);
    expect(estimate.mid!).toBeLessThan(0.42);
    expect(estimate.edgePoints!).toBeLessThan(0);
  });

  it("leaves the price alone when the consensus is neutral", () => {
    const neutral = { ...strongConsensus(), score: 50 };
    expect(computeModelEstimate(0.42, neutral).mid!).toBeCloseTo(0.42, 10);
  });

  it("scales by the headroom in the direction it is moving", () => {
    // The old code always scaled by (1 − price), which handed the biggest markups to the cheapest
    // outcomes — and returnPerDay then divided by price and amplified it again. 44% of
    // positive-edge picks sat under 30¢ and not one was above 70¢.
    const strong = { ...strongConsensus(), score: 90 };
    const cheapUp = computeModelEstimate(0.1, strong).mid! - 0.1;
    const dearUp = computeModelEstimate(0.9, strong).mid! - 0.9;
    // Upward room really is larger at a low price, so this asymmetry is correct...
    expect(cheapUp).toBeGreaterThan(dearUp);

    // ...and it must reverse on the way down, which is what removes the net longshot bias.
    const weak = { ...strongConsensus(), score: 10 };
    const cheapDown = 0.1 - computeModelEstimate(0.1, weak).mid!;
    const dearDown = 0.9 - computeModelEstimate(0.9, weak).mid!;
    expect(dearDown).toBeGreaterThan(cheapDown);
  });

  it("respects the hard cap in both directions", () => {
    const strong = { ...strongConsensus(), score: 100 };
    const weak = { ...strongConsensus(), score: 0 };
    expect(computeModelEstimate(0.5, strong).mid! - 0.5).toBeLessThanOrEqual(0.12 + 1e-9);
    expect(0.5 - computeModelEstimate(0.5, weak).mid!).toBeLessThanOrEqual(0.12 + 1e-9);
  });

  it("never leaves the 1c..99c band even at the extremes", () => {
    const weak = { ...strongConsensus(), score: 0 };
    const strong = { ...strongConsensus(), score: 100 };
    for (const price of [0.02, 0.5, 0.98]) {
      for (const consensus of [weak, strong]) {
        const mid = computeModelEstimate(price, consensus).mid!;
        expect(mid).toBeGreaterThanOrEqual(0.01);
        expect(mid).toBeLessThanOrEqual(0.99);
      }
    }
  });

  it("declines to estimate at unusable prices", () => {
    for (const price of [0, 1, null, NaN]) {
      expect(computeModelEstimate(price, strongConsensus()).mid).toBeNull();
    }
  });

  it("widens the uncertainty band when fewer traders back the signal", () => {
    const many = computeModelEstimate(0.42, strongConsensus());
    const few = computeModelEstimate(
      0.42,
      computeConsensus([holder(), holder()], [], consensusContext),
    );
    const manyWidth = many.high! - many.low!;
    const fewWidth = few.high! - few.low!;
    expect(fewWidth).toBeGreaterThan(manyWidth);
  });

  it("keeps the range inside 0..1", () => {
    const estimate = computeModelEstimate(0.97, strongConsensus());
    expect(estimate.low!).toBeGreaterThan(0);
    expect(estimate.high!).toBeLessThan(1);
  });
});

describe("computeOpportunityScore — degenerate inputs", () => {
  it("never emits NaN or Infinity", () => {
    const consensuses = [
      computeConsensus([], [], consensusContext),
      computeConsensus([holder({ sizeUsd: 0, smartScore: 0 })], [], consensusContext),
      strongConsensus(),
    ];
    const markets = [
      marketInput(),
      marketInput({ currentPrice: null, liquidity: null, spread: null, endDate: null, clarityScore: null }),
      marketInput({ currentPrice: 0, liquidity: 0, spread: 0 }),
      marketInput({ currentPrice: 1, liquidity: 1e12, spread: 1 }),
      marketInput({ hoursSinceLastActivity: null }),
    ];

    for (const consensus of consensuses) {
      for (const market of markets) {
        const result = computeOpportunityScore(market, consensus, NOW);
        expect(Number.isFinite(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(Number.isFinite(result.baseScore)).toBe(true);
        for (const c of result.components) {
          expect(Number.isFinite(c.contribution)).toBe(true);
        }
        for (const p of result.penalties) {
          expect(Number.isFinite(p.points)).toBe(true);
        }
        for (const value of [
          result.payout.shares, result.payout.profit,
          result.modelEstimate.mid, result.modelEstimate.edgePoints,
          result.entryGap.entryGap,
        ]) {
          if (value !== null) expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  it("handles a market with zero liquidity", () => {
    const result = computeOpportunityScore(marketInput({ liquidity: 0 }), strongConsensus(), NOW);
    expect(result.penalties.find((p) => p.key === "low-liquidity")).toBeDefined();
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it("is deterministic", () => {
    const consensus = strongConsensus();
    const market = marketInput();
    expect(computeOpportunityScore(market, consensus, NOW).score).toBe(
      computeOpportunityScore(market, consensus, NOW).score,
    );
  });
});
