/**
 * Fills in the closing price for logged bets whose market has passed its close.
 *
 * The close is the moment the price stops absorbing new information: kickoff for a game, the end
 * date otherwise. Prices after that point are not a market's final assessment of an unknown
 * outcome, they are people trading a result that is partly known, so a price sampled late would
 * flatter or damn a bet for reasons that had nothing to do with the decision.
 *
 * `priceAt` is the same helper the backtest uses, and for the same reason: it returns strictly the
 * last sample AT OR BEFORE the timestamp asked for, so it is structurally incapable of reaching
 * past the close.
 *
 * Runs as a sync stage so `npm run auto` keeps the log current without anyone remembering to.
 */
import { prisma } from "@/lib/db";
import { fetchPriceHistory, priceAt } from "@/lib/polymarket/clob";
import { clvPoints } from "@/lib/clv";
import { safeNumber } from "@/lib/num";

export interface BetSyncStats {
  pending: number;
  priced: number;
  settled: number;
  /** Closed long enough ago that CLOB history no longer reaches back to it. */
  noHistory: number;
  failures: number;
}

/**
 * A bet is only priced once its close is comfortably past, so a market still ticking toward
 * kickoff is not sampled early and frozen.
 */
const SETTLE_DELAY_MS = 10 * 60_000;

export async function syncBets(): Promise<BetSyncStats> {
  const stats: BetSyncStats = { pending: 0, priced: 0, settled: 0, noHistory: 0, failures: 0 };
  const cutoff = new Date(Date.now() - SETTLE_DELAY_MS);

  const pending = await prisma.betLog.findMany({
    where: { clvPoints: null, closesAt: { not: null, lte: cutoff } },
    select: {
      id: true,
      outcomeIndex: true,
      entryPrice: true,
      closesAt: true,
      market: { select: { clobTokenIds: true, resolved: true, resolvedOutcomeIndex: true } },
    },
    take: 200,
  });

  stats.pending = pending.length;

  for (const bet of pending) {
    const token = bet.market.clobTokenIds[bet.outcomeIndex];
    const closesAt = bet.closesAt;
    if (!token || !closesAt) {
      stats.failures++;
      continue;
    }

    try {
      const history = await fetchPriceHistory(token, { interval: "1w", fidelity: 10 });
      const closing = priceAt(history, Math.floor(closesAt.getTime() / 1000));

      if (closing === null) {
        // CLOB history spans weeks, not months. A bet older than that simply cannot be measured,
        // and recording that is better than substituting the current price for the closing one.
        stats.noHistory++;
        await prisma.betLog.update({
          where: { id: bet.id },
          data: { clvSource: "UNAVAILABLE" },
        });
        continue;
      }

      await prisma.betLog.update({
        where: { id: bet.id },
        data: {
          closingPrice: closing,
          closingPriceAt: closesAt,
          clvPoints: clvPoints(bet.entryPrice, closing),
          clvSource: "CLOB_HISTORY",
        },
      });
      stats.priced++;
    } catch {
      // A failed market must not abandon the pass; the stage is safe to re-run.
      stats.failures++;
    }
  }

  stats.settled = await settleResolvedBets();
  return stats;
}

/**
 * Records the actual result once the market resolves.
 *
 * Kept separate from CLV and shown as secondary in the UI. It is the number everyone wants and the
 * one that takes hundreds of bets to mean anything, so it is recorded rather than emphasised.
 */
async function settleResolvedBets(): Promise<number> {
  const unsettled = await prisma.betLog.findMany({
    where: { resolved: false, market: { resolved: true } },
    select: {
      id: true,
      outcomeIndex: true,
      entryPrice: true,
      stake: true,
      market: { select: { resolvedOutcomeIndex: true } },
    },
    take: 500,
  });

  let settled = 0;
  for (const bet of unsettled) {
    const winningIndex = bet.market.resolvedOutcomeIndex;
    if (winningIndex === null) continue;

    const won = winningIndex === bet.outcomeIndex;
    const entry = safeNumber(bet.entryPrice);
    const stake = safeNumber(bet.stake) ?? 0;
    // A winning share settles at $1, so the payout is stake / price and the profit is the rest.
    const pnl = won && entry !== null && entry > 0 ? stake / entry - stake : -stake;

    await prisma.betLog.update({
      where: { id: bet.id },
      data: { resolved: true, won, pnl },
    });
    settled++;
  }
  return settled;
}
