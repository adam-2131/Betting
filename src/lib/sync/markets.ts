/**
 * Market sync — pulls active events (with nested markets) from Gamma and upserts them.
 *
 * Snapshots are written only when something actually moved, so the table records price history
 * rather than accumulating thousands of identical rows.
 */
import type { Market, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { fetchEvents, fetchMarketsByConditionIds } from "@/lib/polymarket/gamma";
import { normalizeEvents, normalizeMarket, type NormalizedMarket } from "@/lib/polymarket/normalize";
import { safeNumber } from "@/lib/num";

/** A snapshot is only worth storing past one of these thresholds. */
const SNAPSHOT_PRICE_DELTA = 0.005; // half a cent
const SNAPSHOT_LIQUIDITY_DELTA = 0.05; // 5%
const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // or every 6 hours regardless

export interface MarketSyncStats {
  eventsFetched: number;
  marketsSeen: number;
  /** The same market can arrive under several events; those copies are collapsed before writing. */
  duplicatesCollapsed: number;
  marketsUpserted: number;
  /** Skipped because nothing we store had changed since the last sync. */
  marketsUnchanged: number;
  snapshotsWritten: number;
  resolvedDetected: number;
}

function marketData(market: NormalizedMarket) {
  return {
    conditionId: market.conditionId,
    gammaMarketId: market.gammaMarketId,
    question: market.question,
    slug: market.slug,
    eventId: market.eventId,
    eventSlug: market.eventSlug,
    eventTitle: market.eventTitle,
    description: market.description,
    resolutionSource: market.resolutionSource,
    category: market.category,
    tags: market.tags,
    outcomes: market.outcomes,
    clobTokenIds: market.clobTokenIds,
    prices: market.prices,
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    spread: market.spread,
    lastTradePrice: market.lastTradePrice,
    liquidity: market.liquidity,
    volume: market.volume,
    volume24hr: market.volume24hr,
    volume1wk: market.volume1wk,
    openInterest: market.openInterest,
    startDate: market.startDate,
    endDate: market.endDate,
    active: market.active,
    closed: market.closed,
    archived: market.archived,
    acceptingOrders: market.acceptingOrders,
    enableOrderBook: market.enableOrderBook,
    negRisk: market.negRisk,
    resolved: market.resolved,
    resolvedOutcomeIndex: market.resolvedOutcomeIndex,
    clarityScore: market.clarityScore,
    clarityFlags: market.clarityFlags,
    lastSyncedAt: new Date(),
  };
}

/** True when the market moved enough since the last snapshot to be worth recording. */
function shouldSnapshot(existing: Market | null, next: NormalizedMarket, lastSnapshotAt: Date | null): boolean {
  if (!existing || !lastSnapshotAt) return true;
  if (Date.now() - lastSnapshotAt.getTime() > SNAPSHOT_MAX_AGE_MS) return true;

  const prevPrices = existing.prices ?? [];
  for (let i = 0; i < next.prices.length; i++) {
    const prev = safeNumber(prevPrices[i]);
    const now = safeNumber(next.prices[i]);
    if (prev === null || now === null) continue;
    if (Math.abs(now - prev) >= SNAPSHOT_PRICE_DELTA) return true;
  }

  const prevLiquidity = safeNumber(existing.liquidity);
  const nextLiquidity = safeNumber(next.liquidity);
  if (prevLiquidity !== null && nextLiquidity !== null && prevLiquidity > 0) {
    if (Math.abs(nextLiquidity - prevLiquidity) / prevLiquidity >= SNAPSHOT_LIQUIDITY_DELTA) return true;
  }

  // Always record the transition into a resolved state.
  if (next.resolved && !existing.resolved) return true;

  return false;
}

/**
 * Best available resolution timestamp.
 *
 * `endDate` is the scheduled close, not the moment of resolution, and Gamma reports plenty of
 * settled markets whose `endDate` is still in the future — a "will X happen in September" market
 * settles the moment X happens but keeps its end-of-month end date. Taking `endDate` at face value
 * would put a resolution in the future, which the backtest would then try to evaluate from a
 * signal time that has not happened yet. Clamping to now keeps the value a real point in the past;
 * it is still an upper bound on when resolution actually occurred, and treated as such.
 */
function resolutionTimestamp(endDate: Date | null): Date {
  const now = new Date();
  return endDate && endDate < now ? endDate : now;
}

/** Upserts one normalized market and conditionally snapshots it. Returns the row. */
export async function upsertMarket(
  market: NormalizedMarket,
): Promise<{ row: Market; snapshotted: boolean; newlyResolved: boolean }> {
  const existing = await prisma.market.findUnique({ where: { conditionId: market.conditionId } });

  const data = marketData(market);
  const newlyResolved = market.resolved && !(existing?.resolved ?? false);

  const row = existing
    ? await prisma.market.update({
        where: { id: existing.id },
        data: {
          ...data,
          // Only set resolvedAt on the transition, so it records when we first saw resolution.
          resolvedAt: newlyResolved ? resolutionTimestamp(market.endDate) : existing.resolvedAt,
        },
      })
    : await prisma.market.create({
        data: { ...data, resolvedAt: market.resolved ? resolutionTimestamp(market.endDate) : null },
      });

  const lastSnapshot = existing
    ? await prisma.marketSnapshot.findFirst({
        where: { marketId: existing.id },
        orderBy: { capturedAt: "desc" },
        select: { capturedAt: true },
      })
    : null;

  let snapshotted = false;
  if (shouldSnapshot(existing, market, lastSnapshot?.capturedAt ?? null)) {
    await prisma.marketSnapshot.create({
      data: {
        marketId: row.id,
        prices: market.prices,
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        spread: market.spread,
        liquidity: market.liquidity,
        volume24hr: market.volume24hr,
      },
    });
    snapshotted = true;
  }

  return { row, snapshotted, newlyResolved };
}

/**
 * Ensures markets exist for a set of condition ids, fetching any we have not seen.
 * Used by the trader sync, whose positions can reference markets outside the active-event window
 * (including closed ones).
 */
export async function ensureMarketsByConditionIds(conditionIds: string[]): Promise<Map<string, Market>> {
  const unique = [...new Set(conditionIds.filter(Boolean))];
  const result = new Map<string, Market>();
  if (unique.length === 0) return result;

  const known = await prisma.market.findMany({ where: { conditionId: { in: unique } } });
  for (const market of known) result.set(market.conditionId, market);

  const missing = unique.filter((id) => !result.has(id));
  if (missing.length === 0) return result;

  const fetched = await fetchMarketsByConditionIds(missing);
  for (const gammaMarket of fetched) {
    const normalized = normalizeMarket(gammaMarket);
    if (!normalized) continue;
    const { row } = await upsertMarket(normalized);
    result.set(row.conditionId, row);
  }

  return result;
}

/** Chunk size for `IN (...)` pre-loads. Large enough to matter, small enough to stay well
 *  inside parameter limits. */
const LOAD_CHUNK = 500;

/**
 * True when nothing we care about changed, so the row can be skipped entirely.
 *
 * The overwhelming majority of markets are identical between syncs. Writing them anyway is what
 * turns a sync into tens of thousands of statements, and the local PGlite database does not
 * survive that. Comparing first costs nothing — the row is already in memory.
 */
function isUnchanged(existing: Market, next: NormalizedMarket): boolean {
  const samePrices =
    existing.prices.length === next.prices.length &&
    existing.prices.every((p, i) => p === next.prices[i]);

  return (
    samePrices &&
    existing.liquidity === next.liquidity &&
    existing.volume === next.volume &&
    existing.volume24hr === next.volume24hr &&
    existing.spread === next.spread &&
    existing.bestBid === next.bestBid &&
    existing.bestAsk === next.bestAsk &&
    existing.closed === next.closed &&
    existing.resolved === next.resolved &&
    existing.acceptingOrders === next.acceptingOrders &&
    existing.question === next.question &&
    existing.endDate?.getTime() === next.endDate?.getTime()
  );
}

export async function syncMarkets(options: { limit?: number } = {}): Promise<MarketSyncStats> {
  const limit = options.limit ?? Number(process.env.SYNC_MARKET_LIMIT ?? 600);

  const events = await fetchEvents({
    limit,
    active: true,
    closed: false,
    order: "volume24hr",
    ascending: false,
  });

  const markets = normalizeEvents(events).filter(
    // Markets with no order book cannot be traded and have no meaningful price for our purposes.
    (market) => market.enableOrderBook || market.prices.length > 0,
  );

  const stats: MarketSyncStats = {
    eventsFetched: events.length,
    marketsSeen: markets.length,
    duplicatesCollapsed: 0,
    marketsUpserted: 0,
    marketsUnchanged: 0,
    snapshotsWritten: 0,
    resolvedDetected: 0,
  };

  // One market can appear in several events — shared negative-risk legs do this routinely — and
  // the same event can come back twice across overlapping pages. Processing a condition id twice
  // in one pass is wasted work at best, and at worst both copies take the create path (the second
  // one cannot see the row the first just wrote) and hit the unique constraint on conditionId.
  const deduped = [...new Map(markets.map((m) => [m.conditionId, m])).values()];
  stats.duplicatesCollapsed = markets.length - deduped.length;

  // --- Batch pre-load. Two grouped reads replace two per-market reads.
  const conditionIds = deduped.map((m) => m.conditionId);
  const existingByConditionId = new Map<string, Market>();
  for (let i = 0; i < conditionIds.length; i += LOAD_CHUNK) {
    const rows = await prisma.market.findMany({
      where: { conditionId: { in: conditionIds.slice(i, i + LOAD_CHUNK) } },
    });
    for (const row of rows) existingByConditionId.set(row.conditionId, row);
  }

  const existingIds = [...existingByConditionId.values()].map((m) => m.id);
  const lastSnapshotAt = new Map<string, Date>();
  for (let i = 0; i < existingIds.length; i += LOAD_CHUNK) {
    const grouped = await prisma.marketSnapshot.groupBy({
      by: ["marketId"],
      where: { marketId: { in: existingIds.slice(i, i + LOAD_CHUNK) } },
      _max: { capturedAt: true },
    });
    for (const row of grouped) {
      if (row._max.capturedAt) lastSnapshotAt.set(row.marketId, row._max.capturedAt);
    }
  }

  // --- Write only what moved.
  const snapshotQueue: Prisma.MarketSnapshotCreateManyInput[] = [];

  for (const market of deduped) {
    const existing = existingByConditionId.get(market.conditionId) ?? null;
    const wantsSnapshot = shouldSnapshot(existing, market, lastSnapshotAt.get(existing?.id ?? "") ?? null);

    if (existing && !wantsSnapshot && isUnchanged(existing, market)) {
      stats.marketsUnchanged++;
      continue;
    }

    const data = marketData(market);
    const newlyResolved = market.resolved && !(existing?.resolved ?? false);

    const row = existing
      ? await prisma.market.update({
          where: { id: existing.id },
          data: {
            ...data,
            // Only set resolvedAt on the transition, so it records when we first saw resolution.
            resolvedAt: newlyResolved ? resolutionTimestamp(market.endDate) : existing.resolvedAt,
          },
        })
      : await prisma.market.create({
          data: { ...data, resolvedAt: market.resolved ? resolutionTimestamp(market.endDate) : null },
        });

    // Keep the pre-loaded map truthful, so nothing downstream in this pass can decide to create a
    // row that now exists.
    existingByConditionId.set(row.conditionId, row);
    stats.marketsUpserted++;
    if (newlyResolved) stats.resolvedDetected++;

    if (wantsSnapshot) {
      snapshotQueue.push({
        marketId: row.id,
        prices: market.prices,
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        spread: market.spread,
        liquidity: market.liquidity,
        volume24hr: market.volume24hr,
      });
    }
  }

  // One insert per chunk rather than one per snapshot.
  for (let i = 0; i < snapshotQueue.length; i += LOAD_CHUNK) {
    const chunk = snapshotQueue.slice(i, i + LOAD_CHUNK);
    await prisma.marketSnapshot.createMany({ data: chunk });
    stats.snapshotsWritten += chunk.length;
  }

  return stats;
}

/**
 * Refreshes markets we already track that were NOT in the active-event pull — typically because
 * they just closed. Without this, a market a tracked trader holds would never be marked resolved.
 */
export async function refreshStaleTrackedMarkets(maxMarkets = 200): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);

  const stale = await prisma.market.findMany({
    where: {
      resolved: false,
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
      positions: { some: { isOpen: true } },
    },
    select: { conditionId: true },
    take: maxMarkets,
  });

  if (stale.length === 0) return 0;

  const fetched = await fetchMarketsByConditionIds(stale.map((m) => m.conditionId));
  let updated = 0;
  for (const gammaMarket of fetched) {
    const normalized = normalizeMarket(gammaMarket);
    if (!normalized) continue;
    await upsertMarket(normalized);
    updated++;
  }
  return updated;
}
