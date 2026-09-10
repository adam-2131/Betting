import { Category } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { classifyBehavior, type BehaviorTrade } from "./behavior";
import { computeTraderMetrics, computeTraderScore, type ResolvedPosition } from "./trader-score";

const NOW = new Date("2026-09-01T00:00:00Z");

function position(overrides: Partial<ResolvedPosition> = {}): ResolvedPosition {
  return {
    conditionId: `0x${Math.random().toString(16).slice(2)}`,
    category: Category.POLITICS,
    avgPrice: 0.4,
    costBasisUsd: 1000,
    realizedPnl: 500,
    won: true,
    resolvedAt: new Date("2026-06-15T00:00:00Z"),
    ...overrides,
  };
}

/** A deterministic winning record spread across several months. */
function buildRecord(count: number, winRate: number): ResolvedPosition[] {
  const out: ResolvedPosition[] = [];
  for (let i = 0; i < count; i++) {
    const won = i % 100 < winRate * 100;
    out.push(
      position({
        conditionId: `market-${i}`,
        won,
        realizedPnl: won ? 600 : -1000,
        costBasisUsd: 1000,
        avgPrice: 0.4,
        // Spread across 12 months so consistency and monthly buckets are exercised.
        resolvedAt: new Date(Date.UTC(2025, 9 + (i % 12), 10)),
      }),
    );
  }
  return out;
}

describe("computeTraderMetrics — PnL", () => {
  it("keeps realized and unrealized PnL strictly separate", () => {
    const metrics = computeTraderMetrics({
      resolved: [position({ realizedPnl: 1000 }), position({ realizedPnl: -400 })],
      open: [{ currentValue: 5000, cashPnl: 2500 }],
      portfolioValue: 10_000,
      behavior: null,
      now: NOW,
    });

    expect(metrics.realizedPnl).toBe(600);
    expect(metrics.unrealizedPnl).toBe(2500);
    expect(metrics.totalPnl).toBe(3100);
    // The open-position gain must never be folded into the realized figure.
    expect(metrics.realizedPnl).not.toBe(metrics.totalPnl);
  });

  it("reports null PnL rather than 0 when there is no data at all", () => {
    const metrics = computeTraderMetrics({
      resolved: [],
      open: [],
      portfolioValue: null,
      behavior: null,
      now: NOW,
    });
    expect(metrics.realizedPnl).toBeNull();
    expect(metrics.unrealizedPnl).toBeNull();
    expect(metrics.totalPnl).toBeNull();
    expect(metrics.roi).toBeNull();
    expect(metrics.winRate).toBeNull();
  });
});

describe("computeTraderMetrics — ROI and win rate", () => {
  it("computes ROI as realized PnL over total staked", () => {
    const metrics = computeTraderMetrics({
      resolved: [
        position({ costBasisUsd: 1000, realizedPnl: 500 }),
        position({ costBasisUsd: 1000, realizedPnl: -200 }),
      ],
      open: [],
      portfolioValue: null,
      behavior: null,
      now: NOW,
    });
    expect(metrics.totalStaked).toBe(2000);
    expect(metrics.roi).toBeCloseTo(0.15, 10);
  });

  it("excludes positions that did not settle cleanly from the win rate", () => {
    const metrics = computeTraderMetrics({
      resolved: [
        position({ won: true }),
        position({ won: false }),
        position({ won: null }), // voided / still settling
      ],
      open: [],
      portfolioValue: null,
      behavior: null,
      now: NOW,
    });
    expect(metrics.closedCount).toBe(3);
    expect(metrics.winCount).toBe(1);
    expect(metrics.lossCount).toBe(1);
    // 1 of 2 decided, not 1 of 3.
    expect(metrics.winRate).toBe(0.5);
  });

  it("returns null ROI rather than dividing by a zero stake", () => {
    const metrics = computeTraderMetrics({
      resolved: [position({ costBasisUsd: 0, realizedPnl: 0 })],
      open: [],
      portfolioValue: null,
      behavior: null,
      now: NOW,
    });
    expect(metrics.roi).toBeNull();
  });
});

describe("computeTraderMetrics — entry-price buckets", () => {
  it("assigns positions to the correct bucket", () => {
    const metrics = computeTraderMetrics({
      resolved: [
        position({ avgPrice: 0.05 }),
        position({ avgPrice: 0.2 }),
        position({ avgPrice: 0.5 }),
        position({ avgPrice: 0.98 }),
        position({ avgPrice: 0.98 }),
      ],
      open: [],
      portfolioValue: null,
      behavior: null,
      now: NOW,
    });

    const byKey = Object.fromEntries(metrics.entryBuckets.map((b) => [b.bucket, b.count]));
    expect(byKey["0-10"]).toBe(1);
    expect(byKey["10-25"]).toBe(1);
    expect(byKey["40-60"]).toBe(1);
    expect(byKey["90-100"]).toBe(2);
  });

  it("always returns all seven buckets, including empty ones", () => {
    const metrics = computeTraderMetrics({
      resolved: [position({ avgPrice: 0.5 })],
      open: [],
      portfolioValue: null,
      behavior: null,
      now: NOW,
    });
    expect(metrics.entryBuckets).toHaveLength(7);
    const empty = metrics.entryBuckets.find((b) => b.bucket === "0-10");
    expect(empty?.count).toBe(0);
    expect(empty?.roi).toBeNull();
  });

  it("includes 1.0 in the top bucket rather than dropping it", () => {
    const metrics = computeTraderMetrics({
      resolved: [position({ avgPrice: 1 })],
      open: [],
      portfolioValue: null,
      behavior: null,
      now: NOW,
    });
    expect(metrics.entryBuckets.find((b) => b.bucket === "90-100")?.count).toBe(1);
  });
});

describe("computeTraderScore", () => {
  it("produces a 0-100 score whose components and penalties are all exposed", () => {
    const result = computeTraderScore({
      resolved: buildRecord(60, 0.6),
      open: [{ currentValue: 1000, cashPnl: 100 }],
      portfolioValue: 50_000,
      behavior: null,
      now: NOW,
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.components).toHaveLength(7);
    expect(result.components.map((c) => c.key)).toEqual([
      "longTerm", "consistency", "recentForm", "categorySkill",
      "riskAdjusted", "sampleQuality", "conviction",
    ]);
    // Every component carries its own detail string for display.
    for (const component of result.components) {
      expect(component.detail).toBeTruthy();
      expect(Number.isFinite(component.contribution)).toBe(true);
    }
  });

  it("scores a profitable long record above an unprofitable one", () => {
    const good = computeTraderScore({
      resolved: buildRecord(60, 0.7),
      open: [], portfolioValue: 50_000, behavior: null, now: NOW,
    });
    const bad = computeTraderScore({
      resolved: buildRecord(60, 0.2),
      open: [], portfolioValue: 50_000, behavior: null, now: NOW,
    });
    expect(good.score).toBeGreaterThan(bad.score);
  });

  it("penalises a very small sample", () => {
    const result = computeTraderScore({
      resolved: buildRecord(3, 1),
      open: [], portfolioValue: 1000, behavior: null, now: NOW,
    });
    const penalty = result.penalties.find((p) => p.key === "small-sample");
    expect(penalty).toBeDefined();
    expect(penalty!.points).toBeLessThan(0);
  });

  it("penalises a record built on 95¢+ favourites", () => {
    const favourites = Array.from({ length: 40 }, (_, i) =>
      position({
        conditionId: `fav-${i}`,
        avgPrice: 0.97,
        costBasisUsd: 1000,
        realizedPnl: 30,
        won: true,
        resolvedAt: new Date(Date.UTC(2025, 9 + (i % 12), 5)),
      }),
    );
    const result = computeTraderScore({
      resolved: favourites, open: [], portfolioValue: 50_000, behavior: null, now: NOW,
    });
    const penalty = result.penalties.find((p) => p.key === "high-price");
    expect(penalty).toBeDefined();
    expect(penalty!.detail).toMatch(/95¢/);
  });

  it("penalises a record dominated by a single win", () => {
    const record = [
      ...Array.from({ length: 20 }, (_, i) =>
        position({ conditionId: `s-${i}`, realizedPnl: 10, costBasisUsd: 500, won: true,
          resolvedAt: new Date(Date.UTC(2025, 9 + (i % 12), 5)) }),
      ),
      position({ conditionId: "whale", realizedPnl: 100_000, costBasisUsd: 5000, won: true }),
    ];
    const result = computeTraderScore({
      resolved: record, open: [], portfolioValue: 50_000, behavior: null, now: NOW,
    });
    expect(result.penalties.find((p) => p.key === "one-win")).toBeDefined();
  });

  it("penalises high concentration in open positions", () => {
    const result = computeTraderScore({
      resolved: buildRecord(60, 0.6),
      open: [
        { currentValue: 100_000, cashPnl: 0 },
        { currentValue: 500, cashPnl: 0 },
      ],
      portfolioValue: 100_500, behavior: null, now: NOW,
    });
    expect(result.penalties.find((p) => p.key === "concentration")).toBeDefined();
  });

  it("penalises a wallet classified as a scalper", () => {
    const trades: BehaviorTrade[] = [];
    for (let i = 0; i < 2000; i++) {
      const base = Math.floor(NOW.getTime() / 1000) - i * 200;
      trades.push({ conditionId: `m-${i % 20}`, asset: `a-${i % 20}`, outcomeIndex: 0, side: "BUY", timestamp: base, usdcSize: 10 });
      trades.push({ conditionId: `m-${i % 20}`, asset: `a-${i % 20}`, outcomeIndex: 0, side: "SELL", timestamp: base + 120, usdcSize: 10 });
    }
    const behavior = classifyBehavior({
      trades, closedPositionCount: 100, heldToResolutionCount: 2,
      portfolioValue: 10_000, now: NOW,
    });
    expect(behavior.classification).toBe("SCALPER");

    const result = computeTraderScore({
      resolved: buildRecord(60, 0.6), open: [], portfolioValue: 10_000, behavior, now: NOW,
    });
    expect(result.penalties.some((p) => p.key === "bot" || p.key === "short-hold")).toBe(true);
  });

  it("handles a trader with no history at all without throwing or emitting NaN", () => {
    const result = computeTraderScore({
      resolved: [], open: [], portfolioValue: null, behavior: null, now: NOW,
    });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    for (const component of result.components) {
      expect(Number.isFinite(component.contribution)).toBe(true);
    }
  });

  it("never emits NaN or Infinity for any input shape", () => {
    const cases: ResolvedPosition[][] = [
      [],
      [position({ costBasisUsd: 0, realizedPnl: 0, avgPrice: 0 })],
      [position({ costBasisUsd: null, realizedPnl: null, avgPrice: null, resolvedAt: null })],
      [position({ costBasisUsd: 1e12, realizedPnl: -1e12 })],
      buildRecord(1, 1),
    ];
    for (const resolved of cases) {
      const result = computeTraderScore({
        resolved, open: [], portfolioValue: null, behavior: null, now: NOW,
      });
      expect(Number.isFinite(result.score)).toBe(true);
      expect(Number.isFinite(result.baseScore)).toBe(true);
      expect(Number.isFinite(result.penaltyTotal)).toBe(true);
      for (const c of result.components) {
        expect(Number.isFinite(c.contribution)).toBe(true);
        if (c.value !== null) expect(Number.isFinite(c.value)).toBe(true);
      }
    }
  });

  it("is deterministic", () => {
    const input = {
      resolved: buildRecord(30, 0.6), open: [], portfolioValue: 1000, behavior: null, now: NOW,
    };
    expect(computeTraderScore(input).score).toBe(computeTraderScore(input).score);
  });
});
