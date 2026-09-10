/**
 * Score recomputation: behaviour classification, Smart Trader Score, and per-category performance.
 *
 * Reads only from the database — no network. Every trader's score is derived from stored resolved
 * positions and activity, which is what lets the backtest run the same code on historical slices.
 */
import { BehaviorClass, Category } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getScoringConfig } from "@/lib/settings";
import { classifyBehavior, type BehaviorTrade } from "@/lib/scoring/behavior";
import { computeTraderScore, type ResolvedPosition } from "@/lib/scoring/trader-score";
import type { ScoringConfig } from "@/lib/scoring/config";

export interface ScoreSyncStats {
  tradersScored: number;
  categoriesWritten: number;
  errors: string[];
}

/**
 * Must match the `maxItems` used for `/closed-positions` in the trader sync. A trader at this
 * count almost certainly has more history than we hold, and the UI says so rather than presenting
 * a partial record as complete.
 */
export const CLOSED_POSITION_SYNC_CAP = 1000;

const BEHAVIOR_CLASS_MAP: Record<string, BehaviorClass> = {
  DISCRETIONARY: BehaviorClass.DISCRETIONARY,
  POSSIBLE_BOT: BehaviorClass.POSSIBLE_BOT,
  SCALPER: BehaviorClass.SCALPER,
  MARKET_MAKER: BehaviorClass.MARKET_MAKER,
  UNKNOWN: BehaviorClass.UNKNOWN,
};

/**
 * Recomputes one trader's performance rollup.
 *
 * `asOf` bounds which resolved positions are visible. The live path passes the current time; the
 * backtest passes a historical timestamp so a wallet is scored using only what had settled by then.
 */
export async function scoreTrader(
  traderId: string,
  config: ScoringConfig,
  asOf: Date = new Date(),
): Promise<boolean> {
  const [closedRows, openRows, activityRows, latestSnapshot] = await Promise.all([
    prisma.closedPosition.findMany({
      where: {
        traderId,
        // Only positions that had resolved by `asOf` count toward the track record.
        OR: [{ resolvedAt: { lte: asOf } }, { resolvedAt: null }],
      },
    }),
    prisma.position.findMany({
      where: { traderId, isOpen: true },
      select: { currentValue: true, cashPnl: true },
    }),
    prisma.tradeActivity.findMany({
      where: { traderId, occurredAt: { lte: asOf } },
      select: {
        conditionId: true,
        asset: true,
        outcomeIndex: true,
        side: true,
        timestamp: true,
        usdcSize: true,
      },
      orderBy: { timestamp: "desc" },
      take: 5000,
    }),
    prisma.traderSnapshot.findFirst({
      where: { traderId, capturedAt: { lte: asOf } },
      orderBy: { capturedAt: "desc" },
      select: { portfolioValue: true },
    }),
  ]);

  const resolved: ResolvedPosition[] = closedRows.map((row) => ({
    conditionId: row.conditionId,
    category: row.category,
    avgPrice: row.avgPrice,
    costBasisUsd: row.costBasisUsd,
    realizedPnl: row.realizedPnl,
    won: row.won,
    resolvedAt: row.resolvedAt,
  }));

  const trades: BehaviorTrade[] = activityRows.map((row) => ({
    conditionId: row.conditionId,
    asset: row.asset,
    outcomeIndex: row.outcomeIndex,
    side: row.side,
    timestamp: row.timestamp,
    usdcSize: row.usdcSize,
  }));

  const portfolioValue = latestSnapshot?.portfolioValue ?? null;

  // A position that settled at a clean 1 or 0 was held through resolution rather than sold early.
  const heldToResolutionCount = closedRows.filter((row) => row.won !== null).length;

  const behavior = classifyBehavior(
    {
      trades,
      closedPositionCount: closedRows.length,
      heldToResolutionCount,
      portfolioValue,
      now: asOf,
    },
    config,
  );

  const result = computeTraderScore(
    { resolved, open: openRows, portfolioValue, behavior, now: asOf },
    config,
  );

  const metrics = result.metrics;

  await prisma.traderPerformance.upsert({
    where: { traderId },
    create: buildPerformanceData(traderId, result, behavior, metrics),
    update: buildPerformanceData(traderId, result, behavior, metrics),
  });

  // Per-category rows, replaced wholesale so a category that fell out of the record disappears.
  await prisma.traderCategoryPerformance.deleteMany({ where: { traderId } });
  if (metrics.categories.length > 0) {
    await prisma.traderCategoryPerformance.createMany({
      data: metrics.categories.map((stat) => ({
        traderId,
        category: stat.category as Category,
        closedCount: stat.closedCount,
        winCount: stat.winCount,
        winRate: stat.winRate,
        realizedPnl: stat.realizedPnl,
        totalStaked: stat.totalStaked,
        roi: stat.roi,
        skillScore: stat.skillScore,
      })),
      skipDuplicates: true,
    });
  }

  return true;
}

function buildPerformanceData(
  traderId: string,
  result: ReturnType<typeof computeTraderScore>,
  behavior: ReturnType<typeof classifyBehavior>,
  metrics: ReturnType<typeof computeTraderScore>["metrics"],
) {
  return {
    traderId,
    computedAt: new Date(),
    realizedPnl: metrics.realizedPnl,
    unrealizedPnl: metrics.unrealizedPnl,
    totalPnl: metrics.totalPnl,
    portfolioValue: metrics.portfolioValue,
    closedCount: metrics.closedCount,
    winCount: metrics.winCount,
    lossCount: metrics.lossCount,
    winRate: metrics.winRate,
    totalStaked: metrics.totalStaked,
    roi: metrics.roi,
    avgEntryPrice: metrics.avgEntryPrice,
    avgPositionUsd: metrics.avgPositionUsd,
    largestPositionUsd: metrics.largestPositionUsd,
    largestWinUsd: metrics.largestWinUsd,
    largestLossUsd: metrics.largestLossUsd,
    redemptionBiasSuspected: metrics.redemptionBiasSuspected,
    // The closed-position pull is capped per sync, so a very long history is a recent subset.
    historyTruncated: metrics.closedCount >= CLOSED_POSITION_SYNC_CAP,
    smartScore: result.score,
    components: result.components as unknown as object,
    penalties: result.penalties as unknown as object,
    behaviorClass: BEHAVIOR_CLASS_MAP[behavior.classification] ?? BehaviorClass.UNKNOWN,
    behaviorConfidence: behavior.confidenceScore,
    behaviorReasons: {
      summary: behavior.summary,
      confidence: behavior.confidence,
      excludable: behavior.excludable,
      reasons: behavior.reasons,
    } as unknown as object,
    tradeCount: behavior.metrics.tradeCount,
    tradesLast7d: behavior.metrics.tradesLast7d,
    tradesLast30d: behavior.metrics.tradesLast30d,
    medianHoldSeconds: behavior.metrics.medianHoldSeconds,
    heldToResolutionPct: behavior.metrics.heldToResolutionPct,
    bothSidesMarketCount: behavior.metrics.bothSidesMarketCount,
    turnoverRatio: behavior.metrics.turnoverRatio,
    concentrationHhi: metrics.concentrationHhi,
    topWinShare: metrics.topWinShare,
    roiLast30d: metrics.roiLast30d,
    roiLast90d: metrics.roiLast90d,
    monthlyWinRate: metrics.monthlyWinRate,
    profitVolatility: metrics.profitVolatility,
    riskAdjustedReturn: metrics.riskAdjustedReturn,
    monthlyPnl: metrics.monthly as unknown as object,
    entryBuckets: metrics.entryBuckets as unknown as object,
    // The full curve can be thousands of points; the UI only needs a readable line.
    pnlCurve: downsampleCurve(metrics.pnlCurve, 400) as unknown as object,
  };
}

/** Evenly thins a series to at most `maxPoints`, always keeping the first and last. */
function downsampleCurve<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export async function syncScores(): Promise<ScoreSyncStats> {
  const config = await getScoringConfig();
  const traders = await prisma.trader.findMany({ where: { active: true }, select: { id: true } });

  const stats: ScoreSyncStats = { tradersScored: 0, categoriesWritten: 0, errors: [] };

  for (const trader of traders) {
    try {
      await scoreTrader(trader.id, config);
      stats.tradersScored++;
    } catch (error) {
      stats.errors.push(
        `${trader.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  stats.categoriesWritten = await prisma.traderCategoryPerformance.count();
  return stats;
}
