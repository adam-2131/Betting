/**
 * PRICE HISTORY BACKFILL
 *
 * Why this stage exists. The backtest compares its win rate against the market's implied
 * probability at the signal moment, so that benchmark has to be a price from *near* that moment.
 * Before this stage the only sources were a stored `MarketSnapshot` (which exists solely for the
 * period this installation has been running) or the last tracked fill — with no limit on how old
 * either could be. A fill from three weeks earlier was being used as "the price at T".
 *
 * That is not a neutral approximation. Prices drift toward the eventual outcome as resolution
 * nears, so a stale price is systematically too low on markets that went on to win. Used as the
 * denominator in the payout `(1/p − 1)`, a stale low price inflates the measured return on exactly
 * the signals that won. The bias runs in the flattering direction, which is the dangerous one.
 *
 * `/prices-history` returns the real CLOB curve for a token over its whole life, so the backtest
 * can read a genuine quote within an hour of any signal instead of extrapolating from whatever it
 * happened to see. This is about the accuracy of the benchmark, not about coverage.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { fetchPriceHistory } from "@/lib/polymarket/clob";
import {
  BACKFILL_OVERSHOOT,
  DEFAULT_TESTABLE_LOOKBACK_DAYS,
  DEFAULT_TESTABLE_MARKET_LIMIT,
  TESTABLE_MARKET_ORDER,
  testableMarketWhere,
} from "@/lib/backtest/market-selection";
import type { ClobPricePoint } from "@/lib/polymarket/types";

/** Minutes per sample. 60 keeps series small while staying well inside a one-day signal horizon. */
export const PRICE_FIDELITY = 60;

export interface PriceSyncStats {
  marketsConsidered: number;
  tokensFetched: number;
  tokensStored: number;
  tokensEmpty: number;
  pointsStored: number;
  skippedAlreadyFresh: number;
  errors: number;
}

export interface PriceSyncOptions {
  /** Cap on markets per run; the backfill is long and resumable. */
  maxMarkets?: number;
  /** Only backfill markets that resolved within this many days. */
  lookbackDays?: number;
  /** Re-fetch series older than this even if present. Resolved markets never change, so high. */
  refreshAfterDays?: number;
}

/**
 * Backfills price curves for resolved markets that tracked traders actually touched.
 *
 * Restricted to markets with activity because those are the only ones the backtest can produce a
 * signal for — fetching the full market universe would be tens of thousands of requests for data
 * nothing reads.
 */
export async function syncPriceHistory(options: PriceSyncOptions = {}): Promise<PriceSyncStats> {
  // Defaults are tied to the backtest's own window and cap rather than chosen independently, so
  // the backfill covers a superset of what will be tested.
  const {
    maxMarkets = DEFAULT_TESTABLE_MARKET_LIMIT * BACKFILL_OVERSHOOT,
    lookbackDays = DEFAULT_TESTABLE_LOOKBACK_DAYS,
    refreshAfterDays = 3650,
  } = options;

  const stats: PriceSyncStats = {
    marketsConsidered: 0,
    tokensFetched: 0,
    tokensStored: 0,
    tokensEmpty: 0,
    pointsStored: 0,
    skippedAlreadyFresh: 0,
    errors: 0,
  };

  const since = new Date(Date.now() - lookbackDays * 86_400_000);

  // Identical selector and ordering to the backtest, so this slice is a superset of the markets
  // that will actually be tested. Previously this ordered `desc` while the backtest ordered
  // `asc`, and the two sets overlapped by 7 markets out of 1,500 — see `market-selection.ts`.
  const markets = await prisma.market.findMany({
    where: testableMarketWhere({ from: since, to: new Date() }),
    orderBy: TESTABLE_MARKET_ORDER,
    take: maxMarkets,
    select: { id: true, clobTokenIds: true },
  });

  stats.marketsConsidered = markets.length;
  if (markets.length === 0) return stats;

  // Pre-load what already exists so a resumed run does not refetch it.
  const freshCutoff = new Date(Date.now() - refreshAfterDays * 86_400_000);
  const existing = new Map<string, Date>();
  const marketIds = markets.map((m) => m.id);
  for (let i = 0; i < marketIds.length; i += 500) {
    const rows = await prisma.marketPriceSeries.findMany({
      where: { marketId: { in: marketIds.slice(i, i + 500) } },
      select: { tokenId: true, fetchedAt: true },
    });
    for (const row of rows) existing.set(row.tokenId, row.fetchedAt);
  }

  for (const market of markets) {
    for (const [outcomeIndex, tokenId] of market.clobTokenIds.entries()) {
      if (!tokenId) continue;

      const fetchedAt = existing.get(tokenId);
      if (fetchedAt && fetchedAt > freshCutoff) {
        stats.skippedAlreadyFresh++;
        continue;
      }

      try {
        stats.tokensFetched++;
        const history = await fetchPriceHistory(tokenId, {
          interval: "max",
          fidelity: PRICE_FIDELITY,
        });

        if (history.length === 0) {
          stats.tokensEmpty++;
          continue;
        }

        const first = new Date(history[0].t * 1000);
        const last = new Date(history[history.length - 1].t * 1000);
        const points = history as unknown as Prisma.InputJsonValue;

        await prisma.marketPriceSeries.upsert({
          where: { tokenId },
          create: {
            marketId: market.id,
            tokenId,
            outcomeIndex,
            fidelity: PRICE_FIDELITY,
            points,
            pointCount: history.length,
            firstAt: first,
            lastAt: last,
          },
          update: {
            points,
            pointCount: history.length,
            firstAt: first,
            lastAt: last,
            fetchedAt: new Date(),
          },
        });

        stats.tokensStored++;
        stats.pointsStored += history.length;
      } catch {
        // One bad token must not abandon a backfill of hundreds. The stage is resumable, so an
        // error here simply means this token gets retried on the next run.
        stats.errors++;
      }
    }
  }

  return stats;
}

/** Reads a stored series back into the shape `priceAt` expects. */
export function seriesFromJson(points: unknown): ClobPricePoint[] {
  if (!Array.isArray(points)) return [];
  const out: ClobPricePoint[] = [];
  for (const raw of points) {
    if (!raw || typeof raw !== "object") continue;
    const { t, p } = raw as { t?: unknown; p?: unknown };
    if (typeof t !== "number" || typeof p !== "number") continue;
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    out.push({ t, p });
  }
  return out;
}
