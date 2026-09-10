import { Category } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { computeConsensus, type ConsensusHolder, type ConsensusMarketContext } from "./consensus";

const NOW = new Date("2026-09-01T00:00:00Z");
const HOUR = 3_600_000;

function holder(overrides: Partial<ConsensusHolder> = {}): ConsensusHolder {
  return {
    traderId: `t-${Math.random().toString(36).slice(2)}`,
    wallet: `0x${Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40)}`,
    displayName: "Trader",
    smartScore: 75,
    categorySkill: 70,
    sizeUsd: 10_000,
    avgPrice: 0.3,
    openedAt: new Date(NOW.getTime() - 48 * HOUR),
    typicalPositionUsd: 8_000,
    recentNetUsd: 0,
    likelyBot: false,
    ...overrides,
  };
}

const market: ConsensusMarketContext = {
  category: Category.POLITICS,
  currentPrice: 0.32,
  liquidity: 500_000,
  spread: 0.01,
  now: NOW,
};

describe("computeConsensus — aggregation", () => {
  it("counts qualified traders and exposure on each side", () => {
    const result = computeConsensus(
      [holder({ smartScore: 80, sizeUsd: 100_000 }), holder({ smartScore: 85, sizeUsd: 312_000 })],
      [holder({ smartScore: 70, sizeUsd: 38_000 })],
      market,
    );
    expect(result.traderCount).toBe(2);
    expect(result.qualifiedTraderCount).toBe(2);
    expect(result.opposingTraderCount).toBe(1);
    expect(result.exposureUsd).toBe(412_000);
    expect(result.opposingExposureUsd).toBe(38_000);
  });

  it("counts a wallet once even if it appears several times", () => {
    const wallet = "0xabc0000000000000000000000000000000000001";
    const result = computeConsensus(
      [
        holder({ wallet, sizeUsd: 5_000 }),
        holder({ wallet, sizeUsd: 20_000 }),
        holder({ wallet: wallet.toUpperCase(), sizeUsd: 1_000 }),
      ],
      [],
      market,
    );
    expect(result.traderCount).toBe(1);
    // Keeps the largest of the duplicates rather than summing them.
    expect(result.exposureUsd).toBe(20_000);
  });

  it("does not count a trader as qualified below the score threshold", () => {
    const result = computeConsensus(
      [holder({ smartScore: 40 }), holder({ smartScore: 75 })],
      [],
      market,
    );
    expect(result.traderCount).toBe(2);
    expect(result.qualifiedTraderCount).toBe(1);
  });

  it("tracks recent buying and selling separately", () => {
    const result = computeConsensus(
      [
        holder({ recentNetUsd: 14_200 }),
        holder({ recentNetUsd: 5_000 }),
        holder({ recentNetUsd: -3_000 }),
      ],
      [],
      market,
    );
    expect(result.boughtUsd24h).toBe(19_200);
    expect(result.soldUsd24h).toBe(3_000);
    expect(result.increasingCount).toBe(2);
    expect(result.decreasingCount).toBe(1);
  });
});

describe("computeConsensus — scoring behaviour", () => {
  it("scores broad high-quality agreement above a single mediocre trader", () => {
    const strong = computeConsensus(
      Array.from({ length: 6 }, () => holder({ smartScore: 88, avgPrice: 0.29, recentNetUsd: 5000 })),
      [holder({ smartScore: 65, sizeUsd: 38_000 })],
      market,
    );
    const weak = computeConsensus([holder({ smartScore: 62, sizeUsd: 5_000 })], [], market);
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("penalises one wallet dominating the signal", () => {
    const result = computeConsensus(
      [
        holder({ sizeUsd: 5_000_000, smartScore: 90 }),
        holder({ sizeUsd: 500, smartScore: 65 }),
      ],
      [],
      market,
    );
    expect(result.penalties.find((p) => p.key === "one-wallet")).toBeDefined();
  });

  it("penalises stale positions", () => {
    const result = computeConsensus(
      Array.from({ length: 3 }, () =>
        holder({ openedAt: new Date(NOW.getTime() - 90 * 24 * HOUR), recentNetUsd: 0 }),
      ),
      [],
      market,
    );
    expect(result.penalties.find((p) => p.key === "stale")).toBeDefined();
  });

  it("penalises traders who entered far below today's price", () => {
    const result = computeConsensus(
      Array.from({ length: 3 }, () => holder({ avgPrice: 0.21 })),
      [],
      { ...market, currentPrice: 0.68 },
    );
    const penalty = result.penalties.find((p) => p.key === "entry-gap");
    expect(penalty).toBeDefined();
    expect(result.entryGap).toBeCloseTo(0.47, 6);
  });

  it("penalises thin liquidity and wide spreads", () => {
    const result = computeConsensus([holder(), holder()], [], {
      ...market,
      liquidity: 800,
      spread: 0.09,
    });
    expect(result.penalties.find((p) => p.key === "low-liquidity")).toBeDefined();
    expect(result.penalties.find((p) => p.key === "wide-spread")).toBeDefined();
  });

  it("penalises suspected bots in proportion to their share of the signal", () => {
    const result = computeConsensus(
      [holder({ likelyBot: true }), holder({ likelyBot: true }), holder()],
      [],
      market,
    );
    const penalty = result.penalties.find((p) => p.key === "bots");
    expect(penalty).toBeDefined();
    expect(penalty!.detail).toMatch(/2 of 3/);
  });

  it("flags wallets that opened together at the same price as possibly correlated", () => {
    const openedAt = new Date(NOW.getTime() - 10 * HOUR);
    const result = computeConsensus(
      [
        holder({ openedAt, avgPrice: 0.3 }),
        holder({ openedAt: new Date(openedAt.getTime() + 20 * 60_000), avgPrice: 0.3 }),
        holder({ openedAt: new Date(openedAt.getTime() + 40 * 60_000), avgPrice: 0.305 }),
      ],
      [],
      market,
    );
    const penalty = result.penalties.find((p) => p.key === "possible-correlation");
    expect(penalty).toBeDefined();
    // Must be honest that wallet ownership is not knowable from public data.
    expect(penalty!.detail).toMatch(/approximation/i);
  });
});

describe("computeConsensus — entry price", () => {
  it("weights entry price by exposure and quality", () => {
    const result = computeConsensus(
      [
        holder({ avgPrice: 0.2, sizeUsd: 1_000_000, smartScore: 90 }),
        holder({ avgPrice: 0.6, sizeUsd: 1_000, smartScore: 60 }),
      ],
      [],
      market,
    );
    // Dominated by the large high-quality holder, so close to 20¢.
    expect(result.weightedEntryPrice).toBeLessThan(0.3);
    // The unweighted mean would be 40¢.
    expect(result.avgEntryPrice).toBeCloseTo(0.4, 10);
  });

  it("computes the entry gap against the current price", () => {
    const result = computeConsensus([holder({ avgPrice: 0.29 })], [], {
      ...market,
      currentPrice: 0.32,
    });
    expect(result.entryGap).toBeCloseTo(0.03, 10);
  });
});

describe("computeConsensus — degenerate inputs", () => {
  it("returns a zero score with an explanation when nobody holds the side", () => {
    const result = computeConsensus([], [], market);
    expect(result.score).toBe(0);
    expect(result.traderCount).toBe(0);
    expect(result.weightedEntryPrice).toBeNull();
    expect(result.penalties[0].key).toBe("no-holders");
  });

  it("handles a single trader", () => {
    const result = computeConsensus([holder()], [], market);
    expect(result.traderCount).toBe(1);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it("handles zero-size positions without dividing by zero", () => {
    const result = computeConsensus([holder({ sizeUsd: 0 })], [], market);
    expect(result.exposureUsd).toBe(0);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.topWalletShare).toBeNull();
  });

  it("handles missing market data", () => {
    const result = computeConsensus([holder(), holder()], [], {
      ...market,
      currentPrice: null,
      liquidity: null,
      spread: null,
    });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.entryGap).toBeNull();
  });

  it("never emits NaN or Infinity", () => {
    const cases: ConsensusHolder[][] = [
      [],
      [holder({ sizeUsd: 0, smartScore: 0, avgPrice: 0 })],
      [holder({ sizeUsd: null, smartScore: null, avgPrice: null, openedAt: null, typicalPositionUsd: 0 })],
      [holder({ sizeUsd: 1e12 }), holder({ sizeUsd: 1e-12 })],
    ];
    for (const holders of cases) {
      const result = computeConsensus(holders, [], market);
      expect(Number.isFinite(result.score)).toBe(true);
      expect(Number.isFinite(result.exposureUsd)).toBe(true);
      for (const c of result.components) {
        expect(Number.isFinite(c.contribution)).toBe(true);
      }
      if (result.topWalletShare !== null) {
        expect(Number.isFinite(result.topWalletShare)).toBe(true);
      }
    }
  });
});
