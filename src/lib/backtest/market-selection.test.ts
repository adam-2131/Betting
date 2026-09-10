import { describe, expect, it, vi } from "vitest";
import {
  BACKFILL_OVERSHOOT,
  DEFAULT_TESTABLE_LOOKBACK_DAYS,
  DEFAULT_TESTABLE_MARKET_LIMIT,
  TESTABLE_MARKET_ORDER,
  testableMarketWhere,
} from "./market-selection";

const findManyMarkets = vi.fn();
const findManyPriceSeries = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    market: { findMany: (...args: unknown[]) => findManyMarkets(...args) },
    marketPriceSeries: { findMany: (...args: unknown[]) => findManyPriceSeries(...args) },
  },
}));

vi.mock("@/lib/polymarket/clob", () => ({
  fetchPriceHistory: vi.fn(async () => []),
}));

const { syncPriceHistory } = await import("@/lib/sync/prices");

describe("testableMarketWhere", () => {
  it("requires a resolved market inside the window with tracked activity", () => {
    const from = new Date("2025-01-01");
    const to = new Date("2025-12-31");
    expect(testableMarketWhere({ from, to })).toEqual({
      resolved: true,
      resolvedAt: { gte: from, lte: to },
      activity: { some: {} },
    });
  });

  it("excludes markets with no observable resolution time", () => {
    // A null resolvedAt cannot satisfy a gte/lte bound, which is how markets whose settlement
    // time could not be recovered stay out of the sample instead of being guessed at.
    const where = testableMarketWhere({ from: new Date(0), to: new Date() });
    expect(where.resolvedAt).toHaveProperty("gte");
    expect(where.resolvedAt).toHaveProperty("lte");
  });
});

describe("the backfill covers what the backtest tests", () => {
  it("orders the same way as the backtest", () => {
    // The bug this guards: the backfill ordered `desc` while the backtest ordered `asc`, so with
    // ~19,500 markets in the window and a cap of 1,500 each, the two slices came from opposite
    // ends of a year and overlapped by 7 markets.
    //
    // `desc` specifically, because CLOB price history only reaches back weeks — an oldest-first
    // backfill of 8,974 tokens returned 8,974 empty responses.
    expect(TESTABLE_MARKET_ORDER).toEqual({ resolvedAt: "desc" });
  });

  it("takes strictly more markets than the backtest, so its slice is a superset", () => {
    expect(BACKFILL_OVERSHOOT).toBeGreaterThan(1);
    expect(Number.isInteger(BACKFILL_OVERSHOOT)).toBe(true);
  });

  it("issues the shared selector rather than a query of its own", async () => {
    findManyMarkets.mockResolvedValue([]);

    const before = Date.now();
    await syncPriceHistory();
    const after = Date.now();

    const query = findManyMarkets.mock.calls[0][0];
    expect(query.orderBy).toEqual(TESTABLE_MARKET_ORDER);
    expect(query.where.resolved).toBe(true);
    expect(query.where.activity).toEqual({ some: {} });
    expect(query.take).toBe(DEFAULT_TESTABLE_MARKET_LIMIT * BACKFILL_OVERSHOOT);

    // Same window start as the backtest default, so under `asc` ordering neither stage begins
    // ahead of the other.
    const expectedFrom = before - DEFAULT_TESTABLE_LOOKBACK_DAYS * 86_400_000;
    const actualFrom = (query.where.resolvedAt.gte as Date).getTime();
    expect(actualFrom).toBeGreaterThanOrEqual(expectedFrom - 1000);
    expect(actualFrom).toBeLessThanOrEqual(after - DEFAULT_TESTABLE_LOOKBACK_DAYS * 86_400_000 + 1000);
  });

  it("shares the backtest's window, so neither stage reaches past the other", () => {
    // Under descending order both walk back from now; a shared window plus the larger backfill
    // cap is what makes one slice contain the other.
    const backtestLookback = 365;
    expect(DEFAULT_TESTABLE_LOOKBACK_DAYS).toBe(backtestLookback);
  });
});
