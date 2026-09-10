/**
 * ONE definition of "which markets are testable", shared by the backtest and the price backfill.
 *
 * These two stages have to agree, and they silently did not. Both filtered for resolved markets
 * that tracked traders had touched, but the backtest ordered them `resolvedAt asc` while the
 * backfill ordered them `desc`. With ~19,500 markets in the window and a cap of a few hundred
 * each, the two took opposite ends of a year: of the 1,500 markets the backtest tested, exactly
 * 7 had price history. The backfill spent thousands of requests on markets nothing read, and the
 * backtest fell back to stale trade fills for every single benchmark price — the precise failure
 * the backfill was written to eliminate.
 *
 * Nothing about either stage was individually wrong, which is why it survived review. The fix is
 * structural rather than a corrected constant: there is now one selector, and a divergence would
 * require deliberately editing this file.
 */
import type { Prisma } from "@prisma/client";

export interface MarketSelection {
  from: Date;
  to: Date;
  limit: number;
}

/**
 * Resolved markets a signal can be constructed for.
 *
 * `activity: { some: {} }` is what makes a market testable at all — without a tracked trade there
 * is no signal to evaluate. A market with no observable settlement time is excluded by the
 * `resolvedAt` bounds, which is deliberate: see the resolvedAt repair in `sync/relink.ts`.
 */
export function testableMarketWhere(selection: {
  from: Date;
  to: Date;
}): Prisma.MarketWhereInput {
  return {
    resolved: true,
    resolvedAt: { gte: selection.from, lte: selection.to },
    activity: { some: {} },
  };
}

/**
 * Oldest first.
 *
 * Not arbitrary: a cap combined with newest-first would test only the last few days, which is
 * both a tiny slice and the period where price history is most likely to still be forming. Oldest
 * first is stable — the same markets are selected run to run as new ones resolve, so results stay
 * comparable across runs rather than shifting under a moving window.
 */
export const TESTABLE_MARKET_ORDER: Prisma.MarketOrderByWithRelationInput = { resolvedAt: "asc" };

/**
 * The window both stages default to.
 *
 * These have to match. Under `asc` ordering a backfill starting *earlier* than the backtest burns
 * its budget on markets older than anything that will be tested, which is the same disjoint-set
 * failure in a subtler form.
 */
export const DEFAULT_TESTABLE_LOOKBACK_DAYS = 365;
export const DEFAULT_TESTABLE_MARKET_LIMIT = 1500;

/**
 * How many markets the backfill covers relative to the backtest.
 *
 * Strictly greater, so the backfill's slice stays a superset of the backtest's under identical
 * ordering and window. An equal cap would leave the newest tested markets uncovered the moment
 * the backtest's cap were raised, quietly reintroducing the stale-price problem at the margin.
 */
export const BACKFILL_OVERSHOOT = 3;
