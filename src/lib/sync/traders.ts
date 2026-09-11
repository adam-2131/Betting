/**
 * Trader sync — positions, closed positions, activity and portfolio value per tracked wallet.
 *
 * Activity is fetched incrementally using the highest timestamp already stored, so a routine sync
 * costs one small page rather than re-walking a wallet's whole history.
 */
import type { ActivityType, Prisma, Trader, TradeSide } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  fetchActivity,
  fetchClosedPositions,
  fetchPortfolioValue,
  fetchPositions,
  fetchTradedCount,
} from "@/lib/polymarket/data";
import {
  normalizeActivity,
  normalizeClosedPosition,
  normalizePosition,
  type NormalizedActivity,
} from "@/lib/polymarket/normalize";
import { resolveCategory } from "@/lib/polymarket/categories";
import { safeNumber, sum } from "@/lib/num";
import { ensureMarketsByConditionIds } from "./markets";
import { recordPositionChanges } from "./feed";
import { historyDepthFor, selectTradersToSync, type SyncTier } from "./trader-selection";

const POSITION_SNAPSHOT_SIZE_DELTA = 0.02; // 2%
const POSITION_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface TraderSyncStats {
  wallet: string;
  positions: number;
  positionsClosed: number;
  closedPositions: number;
  /** Already stored and unchanged — settled positions do not move. */
  closedPositionsUnchanged: number;
  activityRows: number;
  snapshotsWritten: number;
  portfolioValue: number | null;
  error?: string;
}

export async function syncTrader(
  trader: Trader,
  /** How much history to pull. Set by the trader's refresh tier — see `trader-selection.ts`. */
  depth: { closedPositions: number; activityItems: number } = {
    closedPositions: 1000,
    activityItems: 3000,
  },
): Promise<TraderSyncStats> {
  const stats: TraderSyncStats = {
    wallet: trader.wallet,
    positions: 0,
    positionsClosed: 0,
    closedPositions: 0,
    closedPositionsUnchanged: 0,
    activityRows: 0,
    snapshotsWritten: 0,
    portfolioValue: null,
  };

  try {
    const [rawPositions, rawClosed, rawActivity, portfolioValue, tradedCount] = await Promise.all([
      fetchPositions(trader.wallet),
      fetchClosedPositions(trader.wallet, { maxItems: depth.closedPositions }),
      fetchActivity(trader.wallet, {
        since: trader.lastActivityTs ?? undefined,
        maxItems: depth.activityItems,
      }),
      fetchPortfolioValue(trader.wallet),
      fetchTradedCount(trader.wallet),
    ]);

    const positions = rawPositions.map(normalizePosition).filter((p) => p !== null);
    const closed = rawClosed.map(normalizeClosedPosition).filter((p) => p !== null);
    const activity = rawActivity.map(normalizeActivity).filter((a) => a !== null);

    // Every market referenced anywhere must exist before we can link to it.
    const conditionIds = [
      ...positions.map((p) => p.conditionId),
      ...closed.map((p) => p.conditionId),
      ...activity.map((a) => a.conditionId),
    ];
    const markets = await ensureMarketsByConditionIds(conditionIds);

    // --- Activity (insert first: position open times are derived from it) ---
    stats.activityRows = await storeActivity(trader.id, activity, markets);

    // --- Open positions ---
    const seenAssets = new Set<string>();
    const previous = await prisma.position.findMany({
      where: { traderId: trader.id, isOpen: true },
    });
    const previousByAsset = new Map(previous.map((p) => [p.asset, p]));

    // Earliest BUY per token, for every token at once. Asking per position turned one query into
    // one per open position, which is the kind of thing that makes a sync take minutes.
    const firstBuyByAsset = new Map<string, Date>();
    if (positions.length > 0) {
      const grouped = await prisma.tradeActivity.groupBy({
        by: ["asset"],
        where: {
          traderId: trader.id,
          side: "BUY",
          asset: { in: positions.map((p) => p.asset) },
        },
        _min: { occurredAt: true },
      });
      for (const row of grouped) {
        if (row.asset && row._min.occurredAt) firstBuyByAsset.set(row.asset, row._min.occurredAt);
      }
    }

    // Last snapshot per existing position, likewise batched.
    const lastPositionSnapshot = new Map<string, { capturedAt: Date; size: number | null }>();
    if (previous.length > 0) {
      const snaps = await prisma.positionSnapshot.findMany({
        where: { positionId: { in: previous.map((p) => p.id) } },
        orderBy: { capturedAt: "desc" },
        distinct: ["positionId"],
        select: { positionId: true, capturedAt: true, size: true },
      });
      for (const s of snaps) {
        lastPositionSnapshot.set(s.positionId, { capturedAt: s.capturedAt, size: s.size });
      }
    }

    const positionSnapshotQueue: Prisma.PositionSnapshotCreateManyInput[] = [];

    for (const position of positions) {
      const market = markets.get(position.conditionId);
      if (!market) continue;
      seenAssets.add(position.asset);

      const firstBuy = firstBuyByAsset.get(position.asset) ?? null;
      const existing = previousByAsset.get(position.asset);
      const row = await prisma.position.upsert({
        where: { traderId_asset: { traderId: trader.id, asset: position.asset } },
        create: {
          traderId: trader.id,
          marketId: market.id,
          asset: position.asset,
          conditionId: position.conditionId,
          outcome: position.outcome,
          outcomeIndex: position.outcomeIndex,
          size: position.size,
          avgPrice: position.avgPrice,
          initialValue: position.initialValue,
          currentValue: position.currentValue,
          cashPnl: position.cashPnl,
          percentPnl: position.percentPnl,
          sharesBought: position.sharesBought,
          realizedPnl: position.realizedPnl,
          curPrice: position.curPrice,
          redeemable: position.redeemable,
          mergeable: position.mergeable,
          negativeRisk: position.negativeRisk,
          openedAt: firstBuy,
          isOpen: true,
        },
        update: {
          marketId: market.id,
          size: position.size,
          avgPrice: position.avgPrice,
          initialValue: position.initialValue,
          currentValue: position.currentValue,
          cashPnl: position.cashPnl,
          percentPnl: position.percentPnl,
          sharesBought: position.sharesBought,
          realizedPnl: position.realizedPnl,
          curPrice: position.curPrice,
          redeemable: position.redeemable,
          mergeable: position.mergeable,
          openedAt: firstBuy ?? existing?.openedAt ?? null,
          lastSeenAt: new Date(),
          isOpen: true,
        },
      });
      stats.positions++;

      const last = lastPositionSnapshot.get(row.id) ?? null;
      if (shouldSnapshotPosition(last, position.size)) {
        positionSnapshotQueue.push({
          positionId: row.id,
          size: position.size,
          avgPrice: position.avgPrice,
          currentValue: position.currentValue,
          cashPnl: position.cashPnl,
          curPrice: position.curPrice,
        });
      }
    }

    if (positionSnapshotQueue.length > 0) {
      await prisma.positionSnapshot.createMany({ data: positionSnapshotQueue });
      stats.snapshotsWritten += positionSnapshotQueue.length;
    }

    // Anything previously open that the API no longer reports has been exited or redeemed.
    const vanished = previous.filter((p) => !seenAssets.has(p.asset));
    if (vanished.length > 0) {
      await prisma.position.updateMany({
        where: { id: { in: vanished.map((p) => p.id) } },
        data: { isOpen: false, size: 0, lastSeenAt: new Date() },
      });
      stats.positionsClosed = vanished.length;
    }

    // --- Feed events, derived by diffing against the previous state ---
    await recordPositionChanges(trader, previous, positions, markets);

    // --- Closed positions ---
    // A settled position does not change. Re-upserting the entire history every sync is what
    // made this the slowest stage by far, so we load what we already have and write only rows
    // that are new or whose reported figures actually moved.
    const existingClosed = new Map<string, { realizedPnl: number | null; won: boolean | null }>();
    if (closed.length > 0) {
      const rows = await prisma.closedPosition.findMany({
        where: { traderId: trader.id, asset: { in: closed.map((p) => p.asset) } },
        select: { asset: true, realizedPnl: true, won: true },
      });
      for (const row of rows) {
        existingClosed.set(row.asset, { realizedPnl: row.realizedPnl, won: row.won });
      }
    }

    for (const position of closed) {
      const prior = existingClosed.get(position.asset);
      if (prior && prior.realizedPnl === position.realizedPnl && prior.won === position.won) {
        stats.closedPositionsUnchanged++;
        continue;
      }

      const market = markets.get(position.conditionId);
      const category = market?.category ?? resolveCategory([], position.title);

      await prisma.closedPosition.upsert({
        where: { traderId_asset: { traderId: trader.id, asset: position.asset } },
        create: {
          traderId: trader.id,
          marketId: market?.id ?? null,
          asset: position.asset,
          conditionId: position.conditionId,
          title: position.title,
          slug: position.slug,
          eventSlug: position.eventSlug,
          outcome: position.outcome,
          outcomeIndex: position.outcomeIndex,
          category,
          avgPrice: position.avgPrice,
          sharesBought: position.sharesBought,
          costBasisUsd: position.costBasisUsd,
          realizedPnl: position.realizedPnl,
          curPrice: position.curPrice,
          won: position.won,
          endDate: position.endDate,
          resolvedAt: position.resolvedAt,
        },
        update: {
          marketId: market?.id ?? null,
          category,
          avgPrice: position.avgPrice,
          sharesBought: position.sharesBought,
          costBasisUsd: position.costBasisUsd,
          realizedPnl: position.realizedPnl,
          curPrice: position.curPrice,
          won: position.won,
          resolvedAt: position.resolvedAt,
        },
      });
      stats.closedPositions++;
    }

    // --- Portfolio snapshot ---
    stats.portfolioValue = portfolioValue;
    await prisma.traderSnapshot.create({
      data: {
        traderId: trader.id,
        portfolioValue,
        openPositionCount: positions.length,
        unrealizedPnl: positions.length > 0 ? sum(positions.map((p) => p.cashPnl)) : null,
        realizedPnlToDate: closed.length > 0 ? sum(closed.map((p) => p.realizedPnl)) : null,
        tradedMarketCount: tradedCount,
      },
    });

    // --- Profile name, opportunistically taken from activity ---
    const profileName = activity.find((a) => a.profileName)?.profileName ?? null;
    const avatarUrl = activity.find((a) => a.avatarUrl)?.avatarUrl ?? null;
    const maxTs = activity.reduce((acc, a) => Math.max(acc, a.timestamp), trader.lastActivityTs ?? 0);

    await prisma.trader.update({
      where: { id: trader.id },
      data: {
        lastSyncedAt: new Date(),
        lastActivityTs: maxTs > 0 ? maxTs : trader.lastActivityTs,
        syncError: null,
        profileName: profileName ?? trader.profileName,
        avatarUrl: avatarUrl ?? trader.avatarUrl,
        profileUrl: trader.profileUrl ?? `https://polymarket.com/profile/${trader.wallet}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stats.error = message;
    await prisma.trader.update({
      where: { id: trader.id },
      data: { lastSyncedAt: new Date(), syncError: message.slice(0, 500) },
    });
  }

  return stats;
}

/** Pure, so the caller can batch-load the last snapshot instead of querying per position. */
function shouldSnapshotPosition(
  last: { capturedAt: Date; size: number | null } | null,
  nextSize: number,
): boolean {
  if (!last) return true;
  if (Date.now() - last.capturedAt.getTime() > POSITION_SNAPSHOT_MAX_AGE_MS) return true;

  const base = safeNumber(last.size);
  if (base === null || base <= 0) return true;
  return Math.abs(nextSize - base) / base >= POSITION_SNAPSHOT_SIZE_DELTA;
}

/** Bulk-inserts activity, skipping rows already stored via the unique dedupe key. */
async function storeActivity(
  traderId: string,
  activity: NormalizedActivity[],
  markets: Map<string, { id: string }>,
): Promise<number> {
  if (activity.length === 0) return 0;

  const rows: Prisma.TradeActivityCreateManyInput[] = activity.map((a) => ({
    traderId,
    marketId: markets.get(a.conditionId)?.id ?? null,
    dedupeKey: a.dedupeKey,
    transactionHash: a.transactionHash,
    timestamp: a.timestamp,
    occurredAt: a.occurredAt,
    conditionId: a.conditionId,
    type: a.type as ActivityType,
    side: (a.side ?? null) as TradeSide | null,
    size: a.size,
    usdcSize: a.usdcSize,
    price: a.price,
    asset: a.asset,
    outcome: a.outcome,
    outcomeIndex: a.outcomeIndex,
    title: a.title,
    slug: a.slug,
    eventSlug: a.eventSlug,
  }));

  const result = await prisma.tradeActivity.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

/**
 * How many wallets are synced at once.
 *
 * The previous implementation was strictly sequential, on the reasoning that the HTTP layer
 * already parallelises. It does — but only WITHIN one wallet, across the five endpoints fetched
 * together. The expensive part of a wallet is `/closed-positions`, which pages fifty rows at a
 * time and so walks its pages one after another. During that walk the per-host token bucket sits
 * mostly idle, and the whole watchlist waits behind it.
 *
 * Running several wallets at once fills that idle time. It does not raise the request rate, which
 * the token bucket still governs centrally; it only stops the bucket from starving. Memory stays
 * bounded because each worker holds one wallet's rows at a time.
 */
const TRADER_SYNC_CONCURRENCY = Number(process.env.SYNC_TRADER_CONCURRENCY ?? 4);

export interface TraderSyncSummary {
  results: TraderSyncStats[];
  /** Wallets due for a refresh that did not fit in this pass's budget. */
  deferred: number;
  /** Wallets skipped because their tier's refresh interval had not elapsed. */
  notDue: number;
  /** How the budget was spent across refresh tiers. */
  byTier: Record<SyncTier, number>;
  watchlistSize: number;
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight, preserving input order in the
 * results. Deliberately tiny: a dependency for this would be silly, and the ordering guarantee
 * matters because the caller reports per-wallet stats.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

export async function syncTraders(
  options: { limit?: number; concurrency?: number } = {},
): Promise<TraderSyncSummary> {
  const budget = options.limit ?? Number(process.env.SYNC_TRADER_LIMIT ?? 250);
  const concurrency = options.concurrency ?? TRADER_SYNC_CONCURRENCY;
  const now = new Date();

  // The whole active watchlist is loaded, but only the columns the selection policy reads. This
  // is a narrow projection over what is now potentially thousands of rows, not the full records.
  const watchlist = await prisma.trader.findMany({
    where: { active: true },
    select: {
      id: true,
      wallet: true,
      lastSyncedAt: true,
      lastActivityTs: true,
      syncError: true,
      performance: { select: { smartScore: true } },
    },
  });

  const selection = selectTradersToSync(
    watchlist.map((t) => ({
      id: t.id,
      wallet: t.wallet,
      lastSyncedAt: t.lastSyncedAt,
      lastActivityTs: t.lastActivityTs,
      smartScore: t.performance?.smartScore ?? null,
      hasSyncError: t.syncError !== null,
    })),
    { budget, now },
  );

  if (selection.selected.length === 0) {
    return {
      results: [],
      deferred: selection.deferred,
      notDue: selection.notDue,
      byTier: selection.byTier,
      watchlistSize: watchlist.length,
    };
  }

  // Full records only for the wallets actually being synced.
  const traders = await prisma.trader.findMany({
    where: { id: { in: selection.selected.map((t) => t.id) } },
  });

  const results = await mapWithConcurrency(traders, concurrency, (trader) =>
    syncTrader(
      trader,
      historyDepthFor(selection.tierById.get(trader.id) ?? "COLD", trader.lastSyncedAt === null),
    ),
  );

  return {
    results,
    deferred: selection.deferred,
    notDue: selection.notDue,
    byTier: selection.byTier,
    watchlistSize: watchlist.length,
  };
}
