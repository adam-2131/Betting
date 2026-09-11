/**
 * IMPORTING YOUR OWN BETS FROM YOUR POLYMARKET ACCOUNT.
 *
 * Manual logging was always the weaker design. It requires remembering, it only captures bets
 * placed while looking at this app, and the price it records is an estimate — the live ask plus a
 * slippage allowance, which is a guess at what you would fill at rather than what you did.
 *
 * Your wallet's own activity is better on all three counts. It needs nothing from you, it includes
 * bets placed from your phone at three in the morning, and every row carries the REAL fill price
 * and timestamp. Since closing line value is the difference between what you paid and where the
 * market closed, an exact entry price is not a nicety — it is half the measurement.
 *
 * NO CREDENTIALS ARE INVOLVED, and this is worth being precise about. The endpoints here are the
 * same public, keyless, read-only ones the app already calls for every wallet on the watchlist.
 * A wallet address is a public identifier, not a secret: it cannot place an order, sign anything
 * or move a cent. Nothing in this file, or anywhere in PolyAlpha, asks for a private key.
 *
 * Settlement comes from `/closed-positions` rather than from the market's outcome. Those disagree
 * whenever a position is exited early — buy at 40¢, sell at 60¢ before the game, and the eventual
 * result says nothing about what you made. The exchange's own realised figure is authoritative;
 * inferring from the winning outcome would silently misreport every trade you closed out of.
 */
import { prisma } from "@/lib/db";
import { fetchActivity, fetchClosedPositions } from "@/lib/polymarket/data";
import { normalizeActivity, normalizeClosedPosition, normalizeWallet } from "@/lib/polymarket/normalize";
import { ensureMarketsByConditionIds } from "@/lib/sync/markets";
import { safeNumber } from "@/lib/num";

export interface WalletImportStats {
  /** False when no wallet is configured; everything else is zero. */
  configured: boolean;
  fillsSeen: number;
  imported: number;
  /** Already imported on an earlier pass. */
  duplicates: number;
  /** Fills whose market could not be resolved, so there is nothing to compare against. */
  unlinked: number;
  settled: number;
}

/**
 * How far back to look on the first import.
 *
 * Closing prices come from CLOB history, which only reaches back weeks — a bet older than that
 * can never be measured, so importing years of it would just fill the log with rows permanently
 * marked "no history".
 */
const FIRST_IMPORT_MAX_FILLS = 500;
const INCREMENTAL_MAX_FILLS = 200;

export async function importWalletBets(): Promise<WalletImportStats> {
  const stats: WalletImportStats = {
    configured: false,
    fillsSeen: 0,
    imported: 0,
    duplicates: 0,
    unlinked: 0,
    settled: 0,
  };

  const settings = await prisma.appSettings.findUnique({ where: { id: "default" } });
  const wallet = settings?.myWallet ? normalizeWallet(settings.myWallet) : null;
  if (!wallet) return stats;
  stats.configured = true;

  // Resume from the newest fill already imported, so a routine pass costs one small page.
  const newest = await prisma.betLog.findFirst({
    where: { source: "WALLET" },
    orderBy: { placedAt: "desc" },
    select: { placedAt: true },
  });
  const since = newest ? Math.floor(newest.placedAt.getTime() / 1000) : undefined;

  const raw = await fetchActivity(wallet, {
    since,
    maxItems: newest ? INCREMENTAL_MAX_FILLS : FIRST_IMPORT_MAX_FILLS,
  });

  // Only BUY fills open a position. A SELL is an exit, and its price belongs to the realised
  // result rather than to an entry that can be compared with a closing line.
  const buys = raw
    .map(normalizeActivity)
    .filter((a) => a !== null)
    .filter((a) => a.type === "TRADE" && a.side === "BUY" && a.price !== null && a.size !== null);

  stats.fillsSeen = buys.length;
  if (buys.length === 0) {
    stats.settled = await settleFromClosedPositions(wallet);
    return stats;
  }

  const markets = await ensureMarketsByConditionIds(buys.map((b) => b.conditionId));

  for (const fill of buys) {
    const market = markets.get(fill.conditionId);
    if (!market) {
      stats.unlinked++;
      continue;
    }

    const price = safeNumber(fill.price);
    const size = safeNumber(fill.size);
    if (price === null || size === null || price <= 0 || price >= 1) {
      stats.unlinked++;
      continue;
    }

    const existing = await prisma.betLog.findUnique({
      where: { externalId: fill.dedupeKey },
      select: { id: true },
    });
    if (existing) {
      stats.duplicates++;
      continue;
    }

    // The board's own view of this side at the time, when it happens to have one. Frequently
    // absent — a bet placed on your phone was never scored here — and null is the honest record.
    const opportunity = await prisma.opportunity.findUnique({
      where: {
        marketId_outcomeIndex: {
          marketId: market.id,
          outcomeIndex: fill.outcomeIndex ?? 0,
        },
      },
      select: { horizonScore: true, modelEstimateMid: true, netEdgePoints: true, qualifiedTraders: true },
    });

    await prisma.betLog.create({
      data: {
        source: "WALLET",
        externalId: fill.dedupeKey,
        asset: fill.asset,
        marketId: market.id,
        outcomeIndex: fill.outcomeIndex ?? 0,
        outcomeLabel:
          fill.outcome ?? market.outcomes[fill.outcomeIndex ?? 0] ?? `Outcome ${fill.outcomeIndex ?? 0}`,
        question: market.question,
        // The real fill, not an estimate of one.
        entryPrice: price,
        stake: safeNumber(fill.usdcSize) ?? size * price,
        placedAt: fill.occurredAt,
        horizonScore: opportunity?.horizonScore ?? null,
        modelMid: opportunity?.modelEstimateMid ?? null,
        netEdgePoints: opportunity?.netEdgePoints ?? null,
        qualifiedTraders: opportunity?.qualifiedTraders ?? null,
        closesAt: market.gameStartTime ?? market.endDate,
      },
    });
    stats.imported++;
  }

  stats.settled = await settleFromClosedPositions(wallet);
  return stats;
}

/**
 * Settles imported bets from the exchange's own realised figures.
 *
 * Matched on the CLOB token, which is what `/closed-positions` keys on. Where several fills bought
 * into one position, the realised profit is apportioned by stake — the exchange reports one figure
 * per token and it belongs to all of them together.
 */
async function settleFromClosedPositions(wallet: string): Promise<number> {
  const open = await prisma.betLog.findMany({
    where: { source: "WALLET", resolved: false, asset: { not: null } },
    select: { id: true, asset: true, stake: true },
  });
  if (open.length === 0) return 0;

  const closed = (await fetchClosedPositions(wallet, { maxItems: 300 }))
    .map(normalizeClosedPosition)
    .filter((p) => p !== null);
  if (closed.length === 0) return 0;

  const byAsset = new Map(closed.map((p) => [p.asset, p]));

  // Total staked per token, so a multi-fill position splits its result rather than each fill
  // claiming the whole of it.
  const stakeByAsset = new Map<string, number>();
  for (const bet of open) {
    if (!bet.asset) continue;
    stakeByAsset.set(bet.asset, (stakeByAsset.get(bet.asset) ?? 0) + bet.stake);
  }

  let settled = 0;
  for (const bet of open) {
    if (!bet.asset) continue;
    const position = byAsset.get(bet.asset);
    if (!position || position.won === null) continue;

    const totalStake = stakeByAsset.get(bet.asset) ?? bet.stake;
    const share = totalStake > 0 ? bet.stake / totalStake : 1;
    const realised = safeNumber(position.realizedPnl);

    await prisma.betLog.update({
      where: { id: bet.id },
      data: {
        resolved: true,
        won: position.won,
        pnl: realised === null ? null : realised * share,
      },
    });
    settled++;
  }

  return settled;
}
