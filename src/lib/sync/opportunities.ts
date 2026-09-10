/**
 * Consensus and opportunity recomputation.
 *
 * For every market a tracked trader holds, this aggregates both sides, scores them, writes the
 * badges, and ranks the result. This is where "who is holding what" becomes "is this still worth
 * looking at today".
 */
import { SignalTone, SignalType, type Category } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSettingsBundle } from "@/lib/settings";
import { safeNumber } from "@/lib/num";
import { AMBIGUOUS_CLARITY_THRESHOLD } from "@/lib/scoring/clarity";
import { computeConsensus, type ConsensusHolder, type ConsensusResult } from "@/lib/scoring/consensus";
import {
  computeOpportunityScore,
  type OpportunityMarketInput,
  type OpportunityResult,
} from "@/lib/scoring/opportunity";
import type { ScoringConfig } from "@/lib/scoring/config";
import { recordConsensusEvents } from "./feed";

export interface OpportunitySyncStats {
  marketsConsidered: number;
  sidesScored: number;
  opportunitiesWritten: number;
  /** Sides scored for the Smart Money screen but not listed, so the gate stays visible. */
  skippedNoQualifiedTrader: number;
  skippedUntradeablePrice: number;
  signalsWritten: number;
  feedEvents: number;
}

const HOUR_MS = 3_600_000;

/** Behaviour classes we treat as "likely bot" when the exclusion setting is on. */
const BOT_CLASSES = new Set(["POSSIBLE_BOT", "SCALPER", "MARKET_MAKER"]);

export async function syncOpportunities(): Promise<OpportunitySyncStats> {
  const { settings, config } = await getSettingsBundle();
  const now = new Date();

  const stats: OpportunitySyncStats = {
    marketsConsidered: 0,
    sidesScored: 0,
    opportunitiesWritten: 0,
    skippedNoQualifiedTrader: 0,
    skippedUntradeablePrice: 0,
    signalsWritten: 0,
    feedEvents: 0,
  };

  // Only markets that are live, tradeable, and actually held by someone we track.
  //
  // Loaded as three flat queries and joined in memory rather than one nested `include`. The
  // nested form re-serialises the full trader record — performance JSON, penalties, per-category
  // rows — once per position, which at this scale produces a payload of hundreds of megabytes
  // and takes the local WASM database down with it. Flat, the same data is a few megabytes.
  const marketRows = await prisma.market.findMany({
    where: {
      closed: false,
      resolved: false,
      acceptingOrders: true,
      positions: { some: { isOpen: true, size: { gt: 0 } } },
    },
    select: {
      id: true,
      conditionId: true,
      question: true,
      slug: true,
      eventSlug: true,
      category: true,
      outcomes: true,
      prices: true,
      endDate: true,
      liquidity: true,
      volume: true,
      volume24hr: true,
      spread: true,
      clarityScore: true,
      clarityFlags: true,
    },
  });

  const positionRows = await prisma.position.findMany({
    where: {
      isOpen: true,
      size: { gt: 0 },
      marketId: { in: marketRows.map((m) => m.id) },
    },
    select: {
      traderId: true,
      marketId: true,
      outcomeIndex: true,
      currentValue: true,
      avgPrice: true,
      openedAt: true,
    },
  });

  // One row per tracked trader, not one per position.
  const traderRows = await prisma.trader.findMany({
    where: { id: { in: [...new Set(positionRows.map((p) => p.traderId))] } },
    select: {
      id: true,
      wallet: true,
      displayName: true,
      performance: {
        select: {
          smartScore: true,
          behaviorClass: true,
          behaviorConfidence: true,
          avgPositionUsd: true,
        },
      },
      categoryPerformance: { select: { category: true, skillScore: true } },
    },
  });
  const traderById = new Map(traderRows.map((t) => [t.id, t]));

  const positionsByMarket = new Map<string, typeof positionRows>();
  for (const position of positionRows) {
    if (!position.marketId) continue;
    const list = positionsByMarket.get(position.marketId);
    if (list) list.push(position);
    else positionsByMarket.set(position.marketId, [position]);
  }

  const markets = marketRows.map((market) => ({
    ...market,
    positions: positionsByMarket.get(market.id) ?? [],
  }));

  stats.marketsConsidered = markets.length;

  const marketIds = markets.map((m) => m.id);
  const recentSince = new Date(now.getTime() - config.consensus.recentActivityHours * HOUR_MS);

  // Two grouped reads instead of two reads per market. At ~1k tracked markets the per-market form
  // meant thousands of round trips for data that fits comfortably in memory.
  const recentActivityRows = await prisma.tradeActivity.findMany({
    where: { marketId: { in: marketIds }, occurredAt: { gte: recentSince }, type: "TRADE" },
    select: {
      marketId: true,
      traderId: true,
      outcomeIndex: true,
      side: true,
      usdcSize: true,
      occurredAt: true,
    },
  });

  const recentActivityByMarket = new Map<string, typeof recentActivityRows>();
  for (const row of recentActivityRows) {
    if (!row.marketId) continue;
    const list = recentActivityByMarket.get(row.marketId);
    if (list) list.push(row);
    else recentActivityByMarket.set(row.marketId, [row]);
  }

  // Most recent trade per market, for the staleness signal.
  const lastActivityRows = await prisma.tradeActivity.groupBy({
    by: ["marketId"],
    where: { marketId: { in: marketIds }, type: "TRADE" },
    _max: { occurredAt: true },
  });
  const lastActivityByMarket = new Map<string, Date | null>(
    lastActivityRows.flatMap((row) =>
      row.marketId ? [[row.marketId, row._max.occurredAt] as [string, Date | null]] : [],
    ),
  );

  // Keep only what we recompute this pass; anything else has gone stale.
  const survivingOpportunityIds: string[] = [];
  const survivingConsensusIds: string[] = [];

  for (const market of markets) {
    const recentActivity = recentActivityByMarket.get(market.id) ?? [];
    const lastActivityAt = lastActivityByMarket.get(market.id) ?? null;

    // Group holders by outcome index.
    const bySide = new Map<number, ConsensusHolder[]>();
    for (const position of market.positions) {
      const trader = traderById.get(position.traderId);
      if (!trader) continue;

      const performance = trader.performance;
      const categorySkill =
        trader.categoryPerformance.find((c) => c.category === market.category)?.skillScore ?? null;

      const behaviorClass = performance?.behaviorClass ?? "UNKNOWN";
      const behaviorConfidence = performance?.behaviorConfidence ?? 0;
      const likelyBot = BOT_CLASSES.has(behaviorClass) && behaviorConfidence >= 0.6;

      // Skip suspected bots entirely when the setting is on, rather than merely down-weighting.
      if (settings.excludeBots && likelyBot) continue;

      const net = recentActivity
        .filter((a) => a.traderId === position.traderId && a.outcomeIndex === position.outcomeIndex)
        .reduce(
          (acc, a) => acc + (a.side === "BUY" ? 1 : -1) * (safeNumber(a.usdcSize) ?? 0),
          0,
        );

      const holder: ConsensusHolder = {
        traderId: position.traderId,
        wallet: trader.wallet,
        displayName: trader.displayName,
        smartScore: performance?.smartScore ?? null,
        categorySkill,
        sizeUsd: position.currentValue,
        avgPrice: position.avgPrice,
        openedAt: position.openedAt,
        typicalPositionUsd: performance?.avgPositionUsd ?? null,
        recentNetUsd: net,
        likelyBot,
      };

      const list = bySide.get(position.outcomeIndex) ?? [];
      list.push(holder);
      bySide.set(position.outcomeIndex, list);
    }

    if (bySide.size === 0) continue;

    const hoursSinceLastActivity = lastActivityAt
      ? (now.getTime() - lastActivityAt.getTime()) / HOUR_MS
      : null;

    for (const [outcomeIndex, holders] of bySide) {
      const opposing = [...bySide.entries()]
        .filter(([index]) => index !== outcomeIndex)
        .flatMap(([, list]) => list);

      const currentPrice = safeNumber(market.prices[outcomeIndex]);

      const consensus = computeConsensus(
        holders,
        opposing,
        {
          category: market.category as Category,
          currentPrice,
          liquidity: market.liquidity,
          spread: market.spread,
          now,
        },
        config,
      );

      const previousConsensus = await prisma.marketConsensus.findUnique({
        where: { marketId_outcomeIndex: { marketId: market.id, outcomeIndex } },
        select: { score: true },
      });

      const consensusRow = await prisma.marketConsensus.upsert({
        where: { marketId_outcomeIndex: { marketId: market.id, outcomeIndex } },
        create: consensusData(market.id, outcomeIndex, consensus),
        update: consensusData(market.id, outcomeIndex, consensus),
      });
      survivingConsensusIds.push(consensusRow.id);
      stats.sidesScored++;

      // Eligibility gate. The consensus row above is written regardless — the Smart Money screen
      // shows what tracked traders hold whether or not it is rankable — but the Opportunities list
      // only carries sides that actually represent a smart-money signal at a tradeable price.
      const elig = config.eligibility;
      if (currentPrice === null || currentPrice <= 0 || currentPrice >= 1) continue;
      if (currentPrice < elig.minListedPrice || currentPrice > elig.maxListedPrice) {
        stats.skippedUntradeablePrice++;
        continue;
      }
      if (consensus.qualifiedTraderCount < elig.minQualifiedTradersToList) {
        stats.skippedNoQualifiedTrader++;
        continue;
      }

      const outcomeLabel = (market.outcomes[outcomeIndex] ?? `Outcome ${outcomeIndex}`).toUpperCase();

      const marketInput: OpportunityMarketInput = {
        conditionId: market.conditionId,
        question: market.question,
        category: market.category as Category,
        outcomeIndex,
        outcomeLabel,
        currentPrice,
        liquidity: market.liquidity,
        spread: market.spread,
        volume24hr: market.volume24hr,
        endDate: market.endDate,
        clarityScore: market.clarityScore,
        clarityFlags: market.clarityFlags,
        hasBotContributors: holders.some((h) => h.likelyBot),
        hoursSinceLastActivity,
      };

      const opportunity = computeOpportunityScore(marketInput, consensus, now, config);

      const row = await prisma.opportunity.upsert({
        where: { marketId_outcomeIndex: { marketId: market.id, outcomeIndex } },
        create: opportunityData(market.id, outcomeIndex, opportunity, consensus, marketInput),
        update: opportunityData(market.id, outcomeIndex, opportunity, consensus, marketInput),
      });
      survivingOpportunityIds.push(row.id);
      stats.opportunitiesWritten++;

      // Badges are regenerated from scratch each pass.
      await prisma.signal.deleteMany({ where: { opportunityId: row.id } });
      const signals = buildSignals(opportunity, consensus, marketInput, config);
      if (signals.length > 0) {
        await prisma.signal.createMany({
          data: signals.map((signal) => ({ ...signal, opportunityId: row.id })),
        });
        stats.signalsWritten += signals.length;
      }

      const recentEntrants = holders.filter(
        (h) => h.openedAt !== null && now.getTime() - h.openedAt.getTime() <= 24 * HOUR_MS,
      ).length;

      stats.feedEvents += await recordConsensusEvents({
        marketId: market.id,
        question: market.question,
        outcomeIndex,
        outcomeLabel,
        previousScore: previousConsensus?.score ?? null,
        nextScore: consensus.score,
        qualifiedTraders: consensus.qualifiedTraderCount,
        weightedEntry: consensus.weightedEntryPrice,
        currentPrice,
        recentEntrantCount: recentEntrants,
      });
    }
  }

  // Drop rows for markets that no longer qualify.
  await prisma.opportunity.deleteMany({ where: { id: { notIn: survivingOpportunityIds } } });
  await prisma.marketConsensus.deleteMany({ where: { id: { notIn: survivingConsensusIds } } });

  await rankOpportunities();
  return stats;
}

/** Assigns dense ranks by score so the UI can show "#1 OPPORTUNITY". */
export async function rankOpportunities(): Promise<void> {
  const rows = await prisma.opportunity.findMany({
    orderBy: { score: "desc" },
    select: { id: true },
  });
  await Promise.all(
    rows.map((row, index) =>
      prisma.opportunity.update({ where: { id: row.id }, data: { rank: index + 1 } }),
    ),
  );
}

function consensusData(marketId: string, outcomeIndex: number, consensus: ConsensusResult) {
  return {
    marketId,
    outcomeIndex,
    computedAt: new Date(),
    score: consensus.score,
    components: consensus.components as unknown as object,
    penalties: consensus.penalties as unknown as object,
    traderCount: consensus.traderCount,
    qualifiedTraderCount: consensus.qualifiedTraderCount,
    opposingTraderCount: consensus.opposingTraderCount,
    exposureUsd: consensus.exposureUsd,
    opposingExposureUsd: consensus.opposingExposureUsd,
    weightedEntryPrice: consensus.weightedEntryPrice,
    avgEntryPrice: consensus.avgEntryPrice,
    currentPrice: consensus.currentPrice,
    entryGap: consensus.entryGap,
    boughtUsd24h: consensus.boughtUsd24h,
    soldUsd24h: consensus.soldUsd24h,
    increasingCount: consensus.increasingCount,
    decreasingCount: consensus.decreasingCount,
    topWalletShare: consensus.topWalletShare,
    medianPositionAgeHours: consensus.medianPositionAgeHours,
    contributors: consensus.contributors as unknown as object,
  };
}

function opportunityData(
  marketId: string,
  outcomeIndex: number,
  opportunity: OpportunityResult,
  consensus: ConsensusResult,
  market: OpportunityMarketInput,
) {
  return {
    marketId,
    outcomeIndex,
    computedAt: new Date(),
    score: opportunity.score,
    components: opportunity.components as unknown as object,
    penalties: opportunity.penalties as unknown as object,
    currentPrice: opportunity.currentPrice ?? 0,
    weightedEliteEntry: consensus.weightedEntryPrice,
    entryGap: opportunity.entryGap.entryGap,
    consensusScore: consensus.score,
    qualifiedTraders: consensus.qualifiedTraderCount,
    opposingTraders: consensus.opposingTraderCount,
    modelEstimateLow: opportunity.modelEstimate.low,
    modelEstimateMid: opportunity.modelEstimate.mid,
    modelEstimateHigh: opportunity.modelEstimate.high,
    edgePoints: opportunity.modelEstimate.edgePoints,
    evPerShare: opportunity.modelEstimate.evPerShare,
    liquidity: market.liquidity,
    spread: market.spread,
    riskLevel: opportunity.riskLevel,
    reasonsFor: opportunity.reasonsFor as unknown as object,
    reasonsAgainst: opportunity.reasonsAgainst as unknown as object,
  };
}

function buildSignals(
  opportunity: OpportunityResult,
  consensus: ConsensusResult,
  market: OpportunityMarketInput,
  config: ScoringConfig,
): Array<{ type: SignalType; tone: SignalTone; label: string; detail: string }> {
  const signals: Array<{ type: SignalType; tone: SignalTone; label: string; detail: string }> = [];

  if (consensus.qualifiedTraderCount >= 3 && consensus.score >= 70) {
    signals.push({
      type: SignalType.STRONG_CONSENSUS,
      tone: SignalTone.POSITIVE,
      label: "STRONG CONSENSUS",
      detail: `${consensus.qualifiedTraderCount} high-quality traders independently hold this side, against ${consensus.opposingTraderCount} opposing.`,
    });
  }

  if (consensus.increasingCount >= 2 && consensus.boughtUsd24h >= 10_000) {
    signals.push({
      type: SignalType.RECENT_ACCUMULATION,
      tone: SignalTone.POSITIVE,
      label: "RECENT ACCUMULATION",
      detail: `${consensus.increasingCount} tracked traders added a combined $${Math.round(consensus.boughtUsd24h).toLocaleString("en-US")} in the last 24 hours.`,
    });
  }

  const categorySkill = consensus.components.find((c) => c.key === "categorySkill")?.value;
  if (categorySkill !== null && categorySkill !== undefined && categorySkill >= 70) {
    signals.push({
      type: SignalType.CATEGORY_EXPERTS,
      tone: SignalTone.POSITIVE,
      label: "CATEGORY EXPERTS",
      detail: `The traders here have an above-average record specifically in ${market.category.toLowerCase()} markets.`,
    });
  }

  if (opportunity.entryGap.quality === "GOOD") {
    signals.push({
      type: SignalType.ENTRY_ATTRACTIVE,
      tone: SignalTone.POSITIVE,
      label: "ENTRY STILL ATTRACTIVE",
      detail: opportunity.entryGap.explanation,
    });
  }

  if (opportunity.entryGap.quality === "POOR" || opportunity.entryGap.quality === "STALE") {
    signals.push({
      type: SignalType.CHASING,
      tone: SignalTone.WARNING,
      label: "CHASING",
      detail: opportunity.entryGap.explanation,
    });
  }

  if (
    consensus.topWalletShare !== null &&
    consensus.topWalletShare > config.opportunity.oneWalletShareThreshold
  ) {
    signals.push({
      type: SignalType.ONE_WALLET_SIGNAL,
      tone: SignalTone.WARNING,
      label: "ONE-WALLET SIGNAL",
      detail: `${Math.round(consensus.topWalletShare * 100)}% of the smart-money score comes from a single trader.`,
    });
  }

  const liquidity = safeNumber(market.liquidity);
  if (liquidity !== null && liquidity < config.opportunity.minLiquidityUsd) {
    signals.push({
      type: SignalType.LOW_LIQUIDITY,
      tone: SignalTone.WARNING,
      label: "LOW LIQUIDITY",
      detail: `Only $${Math.round(liquidity).toLocaleString("en-US")} of liquidity — entering or exiting may move the price.`,
    });
  }

  const spread = safeNumber(market.spread);
  if (spread !== null && spread > config.opportunity.maxAcceptableSpread) {
    signals.push({
      type: SignalType.WIDE_SPREAD,
      tone: SignalTone.WARNING,
      label: "WIDE SPREAD",
      detail: `A ${(spread * 100).toFixed(1)}¢ spread is an immediate cost on entry and exit.`,
    });
  }

  if (market.hasBotContributors) {
    signals.push({
      type: SignalType.POSSIBLE_BOT_ACTIVITY,
      tone: SignalTone.WARNING,
      label: "POSSIBLE BOT ACTIVITY",
      detail: "Some of this signal comes from wallets that behave like bots, so it may not be manually replicable.",
    });
  }

  if (
    market.hoursSinceLastActivity !== null &&
    market.hoursSinceLastActivity > config.opportunity.staleSignalHours
  ) {
    signals.push({
      type: SignalType.STALE_POSITIONS,
      tone: SignalTone.WARNING,
      label: "STALE POSITIONS",
      detail: `No tracked trader has adjusted this position in ${Math.round(market.hoursSinceLastActivity / 24)} days.`,
    });
  }

  if (
    opportunity.hoursUntilResolution !== null &&
    opportunity.hoursUntilResolution < config.opportunity.shortTimeRemainingHours
  ) {
    signals.push({
      type: SignalType.RESOLVING_SOON,
      tone: SignalTone.WARNING,
      label: "RESOLVING SOON",
      detail: `This market resolves in about ${Math.max(1, Math.round(opportunity.hoursUntilResolution))} hours.`,
    });
  }

  if (market.clarityScore !== null && market.clarityScore < AMBIGUOUS_CLARITY_THRESHOLD) {
    signals.push({
      type: SignalType.AMBIGUOUS_RESOLUTION,
      tone: SignalTone.WARNING,
      label: "AMBIGUOUS RESOLUTION",
      detail:
        market.clarityFlags[0] ??
        "The resolution criteria contain subjective language, which adds settlement risk.",
    });
  }

  return signals;
}
