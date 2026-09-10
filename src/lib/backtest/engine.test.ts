import { describe, expect, it } from "vitest";
import { Category } from "@prisma/client";
import { DEFAULT_SCORING_CONFIG } from "@/lib/scoring/config";
import {
  lastSampleAtOrBefore,
  reconstructPositions,
  scoreTradersAsOf,
  spearman,
  summarize,
  type BacktestSignalRow,
} from "./engine";

const T = new Date("2026-06-01T00:00:00Z");
const before = (days: number) => new Date(T.getTime() - days * 86_400_000);
const after = (days: number) => new Date(T.getTime() + days * 86_400_000);

function fill(overrides: Partial<Parameters<typeof reconstructPositions>[0][number]> = {}) {
  return {
    traderId: "t1",
    occurredAt: before(10),
    asset: "a1",
    outcomeIndex: 0,
    side: "BUY" as const,
    shares: 100,
    usd: 30,
    price: 0.3,
    ...overrides,
  };
}

describe("reconstructPositions — look-ahead leak #2", () => {
  it("ignores fills dated after the signal time", () => {
    const positions = reconstructPositions(
      [
        fill({ occurredAt: before(10), shares: 100, usd: 30 }),
        // The trader scaled in massively AFTER the evaluation moment. A naive backtest that used
        // final position sizes would see a huge conviction bet here.
        fill({ occurredAt: after(1), shares: 10_000, usd: 3_000 }),
      ],
      T,
    );

    expect(positions).toHaveLength(1);
    expect(positions[0].shares).toBe(100);
    expect(positions[0].costUsd).toBeCloseTo(30, 6);
  });

  it("averages entry price across multiple buys", () => {
    const positions = reconstructPositions(
      [
        fill({ occurredAt: before(20), shares: 100, usd: 20, price: 0.2 }),
        fill({ occurredAt: before(10), shares: 100, usd: 40, price: 0.4 }),
      ],
      T,
    );

    expect(positions[0].shares).toBe(200);
    expect(positions[0].avgPrice).toBeCloseTo(0.3, 6);
  });

  it("reduces cost basis proportionally on a sell, leaving the average entry unchanged", () => {
    const positions = reconstructPositions(
      [
        fill({ occurredAt: before(20), shares: 200, usd: 60, price: 0.3 }),
        fill({ occurredAt: before(5), side: "SELL", shares: 100, usd: 50, price: 0.5 }),
      ],
      T,
    );

    expect(positions[0].shares).toBeCloseTo(100, 6);
    // Selling at a profit must not distort what the remaining shares cost.
    expect(positions[0].avgPrice).toBeCloseTo(0.3, 6);
    expect(positions[0].costUsd).toBeCloseTo(30, 6);
  });

  it("drops a fully exited position", () => {
    const positions = reconstructPositions(
      [
        fill({ occurredAt: before(20), shares: 100, usd: 30 }),
        fill({ occurredAt: before(5), side: "SELL", shares: 100, usd: 45, price: 0.45 }),
      ],
      T,
    );

    expect(positions).toHaveLength(0);
  });

  it("separates the two sides of a market", () => {
    const positions = reconstructPositions(
      [
        fill({ outcomeIndex: 0, shares: 100, usd: 30 }),
        fill({ traderId: "t2", outcomeIndex: 1, shares: 200, usd: 140 }),
      ],
      T,
    );

    expect(positions.map((p) => p.outcomeIndex).sort()).toEqual([0, 1]);
  });

  it("counts only the last 24 hours as recent accumulation", () => {
    const positions = reconstructPositions(
      [
        fill({ occurredAt: before(30), shares: 100, usd: 30 }),
        fill({ occurredAt: new Date(T.getTime() - 3_600_000), shares: 50, usd: 20 }),
      ],
      T,
    );

    expect(positions[0].recentNetUsd).toBeCloseTo(20, 6);
  });

  it("treats a dust remainder as no position", () => {
    const positions = reconstructPositions(
      [
        fill({ shares: 100, usd: 30 }),
        fill({ side: "SELL", shares: 99.9, usd: 29.97, price: 0.3 }),
      ],
      T,
    );

    expect(positions).toHaveLength(0);
  });

  it("returns nothing when every fill postdates the signal", () => {
    expect(reconstructPositions([fill({ occurredAt: after(1) })], T)).toHaveLength(0);
  });
});

describe("scoreTradersAsOf — look-ahead leak #1", () => {
  const winner = (resolvedAt: Date, index: number) => ({
    traderId: "t1",
    conditionId: `c${index}`,
    category: Category.POLITICS,
    avgPrice: 0.4,
    costBasisUsd: 400,
    realizedPnl: 600,
    won: true,
    resolvedAt,
  });

  it("scores a trader from zero when nothing had resolved yet", () => {
    // 40 wins, all of them AFTER the signal. At T we knew nothing about this wallet.
    const future = Array.from({ length: 40 }, (_, i) => winner(after(i + 1), i));
    const scores = scoreTradersAsOf(new Map([["t1", future]]), T, DEFAULT_SCORING_CONFIG);

    expect(scores.get("t1")).toBe(0);
  });

  it("does not credit a wallet at T for the wins that put it on the watchlist", () => {
    // The realistic contamination case. This wallet is tracked today because of a great run that
    // happened AFTER T; before T it was losing money. Scored with hindsight it looks strong, and
    // a leaky backtest would then treat its pre-T positions as smart-money signals.
    const loser = (resolvedAt: Date, index: number) => ({
      traderId: "t1",
      conditionId: `l${index}`,
      category: Category.POLITICS,
      avgPrice: 0.6,
      costBasisUsd: 600,
      realizedPnl: -600,
      won: false,
      resolvedAt,
    });

    const past = Array.from({ length: 12 }, (_, i) => loser(before(400 - i * 30), i));
    const future = Array.from({ length: 40 }, (_, i) => winner(after(i + 1), 100 + i));
    const record = new Map([["t1", [...past, ...future]]]);

    const atSignal = scoreTradersAsOf(record, T, DEFAULT_SCORING_CONFIG).get("t1") ?? 0;
    const withHindsight =
      scoreTradersAsOf(record, after(60), DEFAULT_SCORING_CONFIG).get("t1") ?? 0;

    expect(atSignal).toBeLessThan(withHindsight);
    // And low enough in absolute terms that it fails the qualified-trader bar.
    expect(atSignal).toBeLessThan(DEFAULT_SCORING_CONFIG.consensus.qualifiedTraderScore);
  });

  it("is unaffected by adding history after the evaluation date", () => {
    const past = Array.from({ length: 12 }, (_, i) => winner(before(400 - i * 30), i));

    const withoutFuture = scoreTradersAsOf(new Map([["t1", past]]), T, DEFAULT_SCORING_CONFIG);
    const withFuture = scoreTradersAsOf(
      new Map([["t1", [...past, winner(after(1), 900), winner(after(2), 901)]]]),
      T,
      DEFAULT_SCORING_CONFIG,
    );

    expect(withFuture.get("t1")).toBe(withoutFuture.get("t1"));
  });

  it("excludes a position resolving exactly at the signal instant", () => {
    // Strictly-before, because a market resolving at T was not yet a known result at T.
    const scores = scoreTradersAsOf(new Map([["t1", [winner(T, 0)]]]), T, DEFAULT_SCORING_CONFIG);
    expect(scores.get("t1")).toBe(0);
  });
});

describe("spearman", () => {
  it("is 1 for a perfectly increasing relationship", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 6);
  });

  it("is -1 for a perfectly decreasing relationship", () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 6);
  });

  it("is null when one series is constant, rather than NaN", () => {
    expect(spearman([1, 2, 3, 4], [5, 5, 5, 5])).toBeNull();
  });

  it("is null below three observations", () => {
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  it("handles ties without producing a non-finite value", () => {
    const r = spearman([1, 1, 2, 2, 3], [0, 1, 0, 1, 1]);
    expect(r === null || Number.isFinite(r)).toBe(true);
  });
});

describe("lastSampleAtOrBefore", () => {
  const points = [
    { t: 100, p: 0.1 },
    { t: 200, p: 0.2 },
    { t: 300, p: 0.3 },
    { t: 400, p: 0.4 },
  ];

  it("never returns a sample from the future", () => {
    // The whole look-ahead guarantee for the series price source rests on this.
    for (const ts of [99, 100, 150, 200, 250, 399, 400, 10_000]) {
      const sample = lastSampleAtOrBefore(points, ts);
      if (sample) expect(sample.t).toBeLessThanOrEqual(ts);
    }
  });

  it("returns the sample exactly at the boundary", () => {
    expect(lastSampleAtOrBefore(points, 200)).toEqual({ t: 200, p: 0.2 });
  });

  it("returns the most recent prior sample between points", () => {
    expect(lastSampleAtOrBefore(points, 250)).toEqual({ t: 200, p: 0.2 });
  });

  it("returns null before the series starts", () => {
    expect(lastSampleAtOrBefore(points, 99)).toBeNull();
    expect(lastSampleAtOrBefore([], 500)).toBeNull();
  });

  it("agrees with a linear scan across a large series", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ t: i * 60, p: i / 1000 }));
    const linear = (ts: number) => {
      let found: { t: number; p: number } | null = null;
      for (const point of many) {
        if (point.t > ts) break;
        found = point;
      }
      return found;
    };
    for (const ts of [0, 1, 59, 60, 30_000, 59_940, 59_941, 100_000]) {
      expect(lastSampleAtOrBefore(many, ts)).toEqual(linear(ts));
    }
  });
});

describe("summarize", () => {
  const emptyCounters = {
    noResolvedOutcome: 0,
    horizonBeforeStart: 0,
    signalNotYetPast: 0,
    noPriceAtSignal: 0,
    priceOutOfBand: 0,
    priceTooStale: 0,
    noHoldersAtSignal: 0,
  };

  function signal(overrides: Partial<BacktestSignalRow> = {}): BacktestSignalRow {
    const priceAtSignal = overrides.priceAtSignal ?? 0.5;
    const won = overrides.won ?? true;
    return {
      marketId: "m1",
      question: "q",
      category: Category.POLITICS,
      outcomeIndex: 0,
      outcomeLabel: "Yes",
      signalAt: before(7),
      priceAtSignal,
      priceSource: "series",
      priceAgeHours: 0.5,
      opportunityScore: 75,
      consensusScore: 60,
      qualifiedTraders: 3,
      holders: 3,
      weightedEntry: 0.45,
      entryGap: 0.05,
      won,
      resolvedAt: T,
      pnlPerDollar: won ? 1 / priceAtSignal - 1 : -1,
      ...overrides,
    };
  }

  it("warns when the benchmark prices were stale at the signal moment", () => {
    // A stale benchmark is not a coverage gap, it biases the result upward, so it must be said.
    const stale = Array.from({ length: 60 }, (_, i) =>
      signal({ priceSource: "trade", priceAgeHours: 72, won: i < 40 }),
    );
    const results = summarize(stale, emptyCounters, 60, 60, 5);

    expect(results.priceQuality.medianAgeHours).toBe(72);
    expect(results.warnings.join(" ")).toContain("hours old at the signal moment");
    expect(results.warnings.join(" ")).toContain("inflates");
  });

  it("stays quiet about staleness when prices came from fresh curves", () => {
    const fresh = Array.from({ length: 60 }, (_, i) =>
      signal({ priceSource: "series", priceAgeHours: 0.4, won: i < 30 }),
    );
    const results = summarize(fresh, emptyCounters, 60, 60, 5);

    expect(results.priceQuality.bySource.series).toBe(60);
    expect(results.warnings.join(" ")).not.toContain("hours old at the signal moment");
  });

  it("counts price sources without losing any signal", () => {
    const mixed = [
      ...Array.from({ length: 10 }, () => signal({ priceSource: "series" })),
      ...Array.from({ length: 5 }, () => signal({ priceSource: "snapshot" })),
      ...Array.from({ length: 3 }, () => signal({ priceSource: "trade" })),
    ];
    const { bySource } = summarize(mixed, emptyCounters, 18, 18, 5).priceQuality;

    expect(bySource).toEqual({ series: 10, snapshot: 5, trade: 3 });
    expect(bySource.series + bySource.snapshot + bySource.trade).toBe(mixed.length);
  });

  it("reports an honest zero edge when the win rate just matches the price", () => {
    // Ten signals at 50c, five winners. The score found nothing, and the summary must say so.
    const signals = [
      ...Array.from({ length: 5 }, () => signal({ won: true })),
      ...Array.from({ length: 5 }, () => signal({ won: false })),
    ];
    const results = summarize(signals, emptyCounters, 10, 10, 4);

    expect(results.winRate).toBeCloseTo(0.5, 6);
    expect(results.impliedWinRate).toBeCloseTo(0.5, 6);
    expect(results.edgePoints).toBeCloseTo(0, 6);
    expect(results.roi).toBeCloseTo(0, 6);
  });

  it("does not mistake a high win rate on favourites for an edge", () => {
    // 90% winners, but every one was priced at 90c. Zero information.
    const signals = [
      ...Array.from({ length: 9 }, () => signal({ priceAtSignal: 0.9, won: true })),
      signal({ priceAtSignal: 0.9, won: false }),
    ];
    const results = summarize(signals, emptyCounters, 10, 10, 4);

    expect(results.winRate).toBeCloseTo(0.9, 6);
    expect(results.edgePoints).toBeCloseTo(0, 6);
  });

  it("computes a $1-stake ROI correctly for a longshot winner", () => {
    // 10c winner returns $9 profit on $1; nine losers lose $1 each. Net zero.
    const signals = [
      signal({ priceAtSignal: 0.1, won: true }),
      ...Array.from({ length: 9 }, () => signal({ priceAtSignal: 0.1, won: false })),
    ];
    const results = summarize(signals, emptyCounters, 10, 10, 4);

    expect(results.roi).toBeCloseTo(0, 6);
  });

  it("keeps every reported figure finite", () => {
    const results = summarize(
      Array.from({ length: 40 }, (_, i) => signal({ won: i % 2 === 0 })),
      emptyCounters,
      40,
      40,
      4,
    );

    for (const value of [
      results.winRate,
      results.impliedWinRate,
      results.edgePoints,
      results.roi,
      results.maxDrawdown,
      results.rankCorrelation,
    ]) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
    for (const bucket of results.buckets) {
      for (const value of [bucket.winRate, bucket.impliedWinRate, bucket.edgePoints, bucket.roi]) {
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("returns nulls rather than NaN for an empty run", () => {
    const results = summarize([], emptyCounters, 0, 0, 0);

    expect(results.signals).toBe(0);
    expect(results.winRate).toBeNull();
    expect(results.impliedWinRate).toBeNull();
    expect(results.roi).toBeNull();
    expect(results.rankCorrelation).toBeNull();
    expect(results.maxDrawdown).toBeNull();
    expect(results.buckets.every((b) => b.winRate === null)).toBe(true);
  });

  it("warns about small samples and always warns about watchlist survivorship", () => {
    const small = summarize([signal()], emptyCounters, 1, 1, 1);
    expect(small.warnings.some((w) => w.includes("historical signals"))).toBe(true);
    expect(small.warnings.some((w) => w.includes("hindsight"))).toBe(true);

    const large = summarize(
      Array.from({ length: 100 }, (_, i) => signal({ won: i % 3 === 0 })),
      emptyCounters,
      100,
      100,
      10,
    );
    expect(large.warnings.some((w) => w.includes("historical signals"))).toBe(false);
    expect(large.warnings.some((w) => w.includes("hindsight"))).toBe(true);
  });

  it("says outright when the score ranked nothing, even alongside a positive aggregate edge", () => {
    // Underdogs at 20c winning 40% of the time carry the aggregate edge; the top-scoring group
    // is priced at 50c and wins only 30%. A reader glancing at the headline would conclude the
    // score works, so the warning has to contradict it explicitly.
    const lowScoreWinners = Array.from({ length: 40 }, (_, i) =>
      signal({ opportunityScore: 10, priceAtSignal: 0.2, won: i < 18 }),
    );
    const highScoreLosers = Array.from({ length: 40 }, (_, i) =>
      signal({ opportunityScore: 75, priceAtSignal: 0.5, won: i < 12 }),
    );

    const results = summarize([...lowScoreWinners, ...highScoreLosers], emptyCounters, 80, 80, 6);

    expect(results.edgePoints).toBeGreaterThan(0);
    expect(results.warnings.some((w) => w.includes("did not lead to better outcomes"))).toBe(true);
    expect(results.warnings.some((w) => w.includes("not monotonic"))).toBe(true);
  });

  it("does not cry non-monotonic when the score actually ranks correctly", () => {
    const lowScoreLosers = Array.from({ length: 40 }, (_, i) =>
      signal({ opportunityScore: 10, priceAtSignal: 0.5, won: i < 12 }),
    );
    const highScoreWinners = Array.from({ length: 40 }, (_, i) =>
      signal({ opportunityScore: 75, priceAtSignal: 0.5, won: i < 30 }),
    );

    const results = summarize([...lowScoreLosers, ...highScoreWinners], emptyCounters, 80, 80, 6);

    expect(results.rankCorrelation).toBeGreaterThan(0);
    expect(results.warnings.some((w) => w.includes("did not lead to better outcomes"))).toBe(false);
    expect(results.warnings.some((w) => w.includes("not monotonic"))).toBe(false);
  });

  it("measures drawdown in resolution order, not signal order", () => {
    const signals = [
      signal({ priceAtSignal: 0.5, won: false, resolvedAt: new Date("2026-01-01T00:00:00Z") }),
      signal({ priceAtSignal: 0.5, won: false, resolvedAt: new Date("2026-01-02T00:00:00Z") }),
      signal({ priceAtSignal: 0.5, won: true, resolvedAt: new Date("2026-01-03T00:00:00Z") }),
    ];
    // Two losses first: cumulative goes 0 → -1 → -2, so the trough is -2.
    expect(summarize(signals, emptyCounters, 3, 3, 2).maxDrawdown).toBeCloseTo(-2, 6);
  });

  it("buckets by opportunity score without dropping or duplicating signals", () => {
    const scores = [0, 19.9, 20, 39.9, 40, 54.9, 55, 69.9, 70, 84.9, 85, 100];
    const results = summarize(
      scores.map((opportunityScore) => signal({ opportunityScore })),
      emptyCounters,
      scores.length,
      scores.length,
      4,
    );

    expect(results.buckets.reduce((acc, b) => acc + b.signals, 0)).toBe(scores.length);
    expect(results.buckets.every((b) => b.signals === 2)).toBe(true);
  });
});
