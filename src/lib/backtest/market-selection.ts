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
 * Newest first.
 *
 * This was `asc` on the reasoning that oldest-first gives a stable, reproducible slice while
 * newest-first chases a moving window. That reasoning was sound and the data contradicted it:
 * CLOB `/prices-history` does not serve old markets. Measured coverage by resolution month —
 *
 *     2025-08 … 2026-01     0 of ~11,000 markets
 *     2026-02 … 2026-07    32 of ~34,000 markets
 *     2026-08           1,106 of  9,896
 *     2026-09           2,787 of  9,573
 *
 * — and a backfill run over the oldest 4,500 markets fetched 8,974 tokens and got 8,974 empty
 * responses. Oldest-first therefore aimed the backtest at precisely the markets where no genuine
 * benchmark price can be obtained, forcing every comparison back onto stale trade fills.
 *
 * So the ordering is not really a choice about sampling; it is dictated by where the data exists.
 * The cost is real and worth stating: the tested sample is drawn from roughly the last six weeks,
 * so it reflects one recent period rather than a year, and results will shift as the window moves.
 * That is a weaker sample than we would like. It is still far better than a year-long sample whose
 * benchmark prices are all fabricated from weeks-old fills.
 */
export const TESTABLE_MARKET_ORDER: Prisma.MarketOrderByWithRelationInput = { resolvedAt: "desc" };

/**
 * The window both stages default to.
 *
 * Under `desc` ordering both walk backwards from now, so a shared window plus a larger cap on the
 * backfill is what keeps its slice a superset. The lookback is generous because the cap, not the
 * window, is what actually bounds the sample.
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
