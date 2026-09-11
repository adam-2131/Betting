/**
 * RETENTION — keeping the database a size somebody can actually host.
 *
 * Left alone, this app grows without limit. A local instance reached 3 GB in a day: 1.49 million
 * activity rows across 1,263 tracked wallets, of which TradeActivity alone was 2,060 MB — 68% of
 * the total. Every free Postgres tier worth using caps at 0.5 GB, so unbounded growth is not a
 * tidiness problem, it is the difference between the product being hostable and not.
 *
 * WHAT IS SAFE TO DELETE, AND WHY.
 *
 * Old activity is the big one, and it is safe because the things derived from it are already
 * denormalised. A position's `openedAt` is computed once from the earliest BUY and then stored on
 * the row — `syncTrader` writes `firstBuy ?? existing.openedAt`, so a position keeps its open time
 * after the fill that established it is gone. Behaviour classification and the recent-accumulation
 * signal both look at recent windows by construction. What is lost is deep holding-period
 * statistics on wallets that have not traded in months, which is the least valuable data here.
 *
 * Resolved markets nobody touched are the second. A market that settled weeks ago, that no tracked
 * trader holds, holds no settled position in, and that you never bet on, is not referenced by any
 * screen. The exclusions matter more than the rule: a market is kept if it backs a track record or
 * one of your bets, because those are the two things that must not silently lose their context.
 *
 * The watchlist cap is the bluntest and most effective. Deleting a trader cascades to its
 * positions, closed positions and activity, so trimming the tail recovers far more than any
 * row-level rule. Wallets are ranked by whether they are actually contributing: a score, recent
 * activity, and never one you added by hand.
 *
 * NOTHING HERE TOUCHES `BetLog`. Your own record is small, irreplaceable, and the one table in the
 * product that is not reconstructible from Polymarket.
 */
import { prisma } from "@/lib/db";

export interface PruneStats {
  enabled: boolean;
  activityDeleted: number;
  marketSnapshotsDeleted: number;
  positionSnapshotsDeleted: number;
  marketsDeleted: number;
  tradersDeleted: number;
  feedEventsDeleted: number;
}

export interface RetentionPolicy {
  /** Activity older than this is deleted. 0 disables. */
  activityDays: number;
  /** Market and position snapshots older than this are deleted. 0 disables. */
  snapshotDays: number;
  /** Resolved, untouched markets that settled longer ago than this are deleted. 0 disables. */
  resolvedMarketDays: number;
  /** Hard cap on tracked wallets. 0 disables. */
  maxWatchlist: number;
}

function envInt(key: string, fallback: number): number {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Defaults are generous, because a local instance on a real disk has no reason to throw data away.
 * A hosted deployment sets these down — see DEPLOY.md — which is the right place for the decision,
 * since only the deployment knows how much room it has.
 */
export function retentionFromEnv(): RetentionPolicy {
  return {
    activityDays: envInt("RETAIN_ACTIVITY_DAYS", 0),
    snapshotDays: envInt("RETAIN_SNAPSHOT_DAYS", 0),
    resolvedMarketDays: envInt("RETAIN_RESOLVED_MARKET_DAYS", 0),
    maxWatchlist: envInt("MAX_WATCHLIST", 0),
  };
}

/** Deletes in bounded batches so one pass cannot lock the table for minutes. */
const BATCH = 20_000;

export async function pruneDatabase(
  policy: RetentionPolicy = retentionFromEnv(),
): Promise<PruneStats> {
  const stats: PruneStats = {
    enabled: false,
    activityDeleted: 0,
    marketSnapshotsDeleted: 0,
    positionSnapshotsDeleted: 0,
    marketsDeleted: 0,
    tradersDeleted: 0,
    feedEventsDeleted: 0,
  };

  const anyRule =
    policy.activityDays > 0 ||
    policy.snapshotDays > 0 ||
    policy.resolvedMarketDays > 0 ||
    policy.maxWatchlist > 0;
  if (!anyRule) return stats;
  stats.enabled = true;

  const now = Date.now();
  const cutoff = (days: number) => new Date(now - days * 86_400_000);

  // --- Watchlist cap first. It cascades, so everything after it has less to do. ---------------
  if (policy.maxWatchlist > 0) {
    const total = await prisma.trader.count();
    if (total > policy.maxWatchlist) {
      // Keep the wallets that are actually contributing. Manually added ones are never dropped:
      // someone chose those deliberately and an automated cap should not overrule that.
      const keep = await prisma.trader.findMany({
        where: { source: { not: "MANUAL" } },
        orderBy: [
          { performance: { smartScore: { sort: "desc", nulls: "last" } } },
          { lastActivityTs: { sort: "desc", nulls: "last" } },
        ],
        select: { id: true },
        take: policy.maxWatchlist,
      });

      const result = await prisma.trader.deleteMany({
        where: {
          source: { not: "MANUAL" },
          id: { notIn: keep.map((t) => t.id) },
        },
      });
      stats.tradersDeleted = result.count;
    }
  }

  // --- Old activity. The single biggest consumer. ----------------------------------------------
  if (policy.activityDays > 0) {
    const before = cutoff(policy.activityDays);
    for (;;) {
      const batch = await prisma.tradeActivity.findMany({
        where: { occurredAt: { lt: before } },
        select: { id: true },
        take: BATCH,
      });
      if (batch.length === 0) break;
      const result = await prisma.tradeActivity.deleteMany({
        where: { id: { in: batch.map((r) => r.id) } },
      });
      stats.activityDeleted += result.count;
      if (batch.length < BATCH) break;
    }
  }

  // --- Snapshots ------------------------------------------------------------------------------
  if (policy.snapshotDays > 0) {
    const before = cutoff(policy.snapshotDays);
    stats.marketSnapshotsDeleted = (
      await prisma.marketSnapshot.deleteMany({ where: { capturedAt: { lt: before } } })
    ).count;
    stats.positionSnapshotsDeleted = (
      await prisma.positionSnapshot.deleteMany({ where: { capturedAt: { lt: before } } })
    ).count;
    stats.feedEventsDeleted = (
      await prisma.feedEvent.deleteMany({ where: { occurredAt: { lt: before } } })
    ).count;
  }

  // --- Settled markets nothing refers to --------------------------------------------------------
  if (policy.resolvedMarketDays > 0) {
    const before = cutoff(policy.resolvedMarketDays);
    for (;;) {
      const batch = await prisma.market.findMany({
        where: {
          resolved: true,
          resolvedAt: { lt: before },
          // Each exclusion is a reason the market still means something to a screen.
          positions: { none: {} },
          closedPositions: { none: {} },
          bets: { none: {} },
        },
        select: { id: true },
        take: 5_000,
      });
      if (batch.length === 0) break;
      const result = await prisma.market.deleteMany({
        where: { id: { in: batch.map((r) => r.id) } },
      });
      stats.marketsDeleted += result.count;
      if (batch.length < 5_000) break;
    }
  }

  return stats;
}
