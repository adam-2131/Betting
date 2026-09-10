/**
 * SMART MONEY CONSENSUS — 0 to 100, per market side.
 *
 * Rewards: multiple independently successful traders agreeing, high Trader Scores, traders with
 * proven skill in that market's category, recent position increases, entries near today's price,
 * and conviction that is large relative to that trader's own normal position size.
 *
 * Penalises: one wallet dominating the signal, stale positions, entries far below today's price,
 * thin liquidity, wide spreads, and suspected bots/scalpers.
 *
 * Each trader is counted exactly once per market side, so a wallet holding several tokens in the
 * same event cannot inflate the agreement count.
 *
 * Pure and synchronous.
 */
import { Category } from "@prisma/client";
import { herfindahl, median, safeNumber, scaleToScore, usdPlain } from "@/lib/num";
import type { ScoringConfig } from "./config";
import { DEFAULT_SCORING_CONFIG } from "./config";
import { analyzeEntryGap, weightedEntryPrice } from "./entry-gap";
import { applyPenalties, combineComponents, type ScorePenalty, type ScoreResult } from "./types";

export interface ConsensusHolder {
  traderId: string;
  wallet: string;
  displayName: string;
  /** Smart Trader Score, 0-100. */
  smartScore: number | null;
  /** This trader's skill score in this market's category, 0-100. */
  categorySkill: number | null;
  /** Current USD value of the position. */
  sizeUsd: number | null;
  /** Cost basis per share, 0..1. */
  avgPrice: number | null;
  /** When the position was first opened, derived from activity. */
  openedAt: Date | null;
  /** This trader's typical position size, for the relative-conviction component. */
  typicalPositionUsd: number | null;
  /** Net USD bought (positive) or sold (negative) in the recent window. */
  recentNetUsd: number | null;
  /** True when behaviour classification suggests a bot/scalper/market maker. */
  likelyBot: boolean;
}

export interface ConsensusMarketContext {
  category: Category;
  currentPrice: number | null;
  liquidity: number | null;
  spread: number | null;
  /** Evaluation clock. */
  now: Date;
}

export interface ConsensusResult extends ScoreResult {
  traderCount: number;
  qualifiedTraderCount: number;
  opposingTraderCount: number;
  exposureUsd: number;
  opposingExposureUsd: number;
  weightedEntryPrice: number | null;
  avgEntryPrice: number | null;
  currentPrice: number | null;
  entryGap: number | null;
  boughtUsd24h: number;
  soldUsd24h: number;
  increasingCount: number;
  decreasingCount: number;
  topWalletShare: number | null;
  medianPositionAgeHours: number | null;
  contributors: Array<{
    traderId: string;
    wallet: string;
    displayName: string;
    smartScore: number | null;
    sizeUsd: number | null;
    avgPrice: number | null;
    weight: number;
    openedAt: string | null;
    recentNetUsd: number | null;
  }>;
}

const HOUR_MS = 3_600_000;

/**
 * A holder's weight in the signal: exposure scaled by quality.
 *
 * Quality is squared-ish (score/100)^1.5 so a 90-score trader counts materially more than a
 * 60-score one, and sub-qualified traders contribute very little without being excluded outright.
 */
function holderWeight(holder: ConsensusHolder, config: ScoringConfig): number {
  const size = safeNumber(holder.sizeUsd) ?? 0;
  if (size <= 0) return 0;
  const score = safeNumber(holder.smartScore) ?? 0;
  const qualityFactor = (Math.max(0, Math.min(100, score)) / 100) ** 1.5;
  const botFactor = holder.likelyBot ? 0.35 : 1;
  // sqrt damps the influence of one very large wallet before penalties even apply.
  return Math.sqrt(size) * qualityFactor * botFactor * (config.consensus.qualifiedTraderScore > 0 ? 1 : 1);
}

export function computeConsensus(
  holders: ConsensusHolder[],
  opposing: ConsensusHolder[],
  market: ConsensusMarketContext,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ConsensusResult {
  const cfg = config.consensus;

  // De-duplicate: one entry per wallet per side.
  const unique = dedupeByWallet(holders);
  const uniqueOpposing = dedupeByWallet(opposing);

  const exposureUsd = unique.reduce((acc, h) => acc + (safeNumber(h.sizeUsd) ?? 0), 0);
  const opposingExposureUsd = uniqueOpposing.reduce((acc, h) => acc + (safeNumber(h.sizeUsd) ?? 0), 0);

  const qualified = unique.filter(
    (h) => (safeNumber(h.smartScore) ?? 0) >= cfg.qualifiedTraderScore,
  );
  const qualifiedOpposing = uniqueOpposing.filter(
    (h) => (safeNumber(h.smartScore) ?? 0) >= cfg.qualifiedTraderScore,
  );

  const weights = unique.map((h) => ({ holder: h, weight: holderWeight(h, config) }));
  const totalWeight = weights.reduce((acc, w) => acc + w.weight, 0);

  const weightedEntry = weightedEntryPrice(
    weights.map(({ holder, weight }) => ({ avgPrice: holder.avgPrice, weight })),
  );
  const avgEntry =
    unique.length > 0
      ? unique.map((h) => safeNumber(h.avgPrice)).filter((n): n is number => n !== null)
      : [];
  const avgEntryPrice = avgEntry.length > 0 ? avgEntry.reduce((a, b) => a + b, 0) / avgEntry.length : null;

  const gap = analyzeEntryGap(market.currentPrice, weightedEntry, config);

  const boughtUsd24h = unique.reduce((acc, h) => acc + Math.max(0, safeNumber(h.recentNetUsd) ?? 0), 0);
  const soldUsd24h = unique.reduce((acc, h) => acc + Math.max(0, -(safeNumber(h.recentNetUsd) ?? 0)), 0);
  const increasingCount = unique.filter((h) => (safeNumber(h.recentNetUsd) ?? 0) > 0).length;
  const decreasingCount = unique.filter((h) => (safeNumber(h.recentNetUsd) ?? 0) < 0).length;

  const topWalletShare =
    totalWeight > 0 ? Math.max(...weights.map((w) => w.weight)) / totalWeight : null;

  const ages = unique
    .map((h) => (h.openedAt ? (market.now.getTime() - h.openedAt.getTime()) / HOUR_MS : null))
    .filter((n): n is number => n !== null && n >= 0);
  const medianPositionAgeHours = ages.length > 0 ? median(ages) : null;

  if (unique.length === 0) {
    return {
      score: 0,
      baseScore: 0,
      components: [],
      penalties: [
        {
          key: "no-holders",
          label: "No tracked traders",
          points: 0,
          detail: "No tracked trader holds this side of the market.",
        },
      ],
      penaltyTotal: 0,
      traderCount: 0,
      qualifiedTraderCount: 0,
      opposingTraderCount: uniqueOpposing.length,
      exposureUsd: 0,
      opposingExposureUsd,
      weightedEntryPrice: null,
      avgEntryPrice: null,
      currentPrice: safeNumber(market.currentPrice),
      entryGap: null,
      boughtUsd24h: 0,
      soldUsd24h: 0,
      increasingCount: 0,
      decreasingCount: 0,
      topWalletShare: null,
      medianPositionAgeHours: null,
      contributors: [],
    };
  }

  // --- Components -----------------------------------------------------------

  // Agreement: how many qualified traders independently hold this side, net of opposition.
  // sqrt saturation so the 6th trader adds less than the 2nd.
  const netQualified = qualified.length - qualifiedOpposing.length * 0.5;
  const agreement = scaleToScore(
    Math.sqrt(Math.max(0, netQualified)) / Math.sqrt(cfg.agreementSaturation),
    0,
    1,
  );

  // Trader quality: exposure-weighted mean Smart Trader Score.
  const traderQuality =
    totalWeight > 0
      ? weights.reduce(
          (acc, { holder, weight }) => acc + (safeNumber(holder.smartScore) ?? 0) * (weight / totalWeight),
          0,
        )
      : null;

  // Category skill: weighted mean of the holders' skill in THIS market's category.
  const categorySkillEntries = weights.filter(({ holder }) => holder.categorySkill !== null);
  const categorySkillWeight = categorySkillEntries.reduce((acc, w) => acc + w.weight, 0);
  const categorySkill =
    categorySkillWeight > 0
      ? categorySkillEntries.reduce(
          (acc, { holder, weight }) =>
            acc + (holder.categorySkill as number) * (weight / categorySkillWeight),
          0,
        )
      : null;

  // Recency: recent net buying relative to standing exposure, plus how many are adding.
  const recency = (() => {
    if (exposureUsd <= 0) return null;
    const netFlow = (boughtUsd24h - soldUsd24h) / exposureUsd;
    const flowScore = scaleToScore(netFlow, -0.2, 0.3);
    const participationScore =
      unique.length > 0 ? (increasingCount / unique.length) * 100 : null;
    if (flowScore === null) return participationScore;
    if (participationScore === null) return flowScore;
    return flowScore * 0.6 + participationScore * 0.4;
  })();

  // Relative conviction: position size versus that trader's own typical size.
  const convictionRelative = (() => {
    const ratios = unique
      .map((h) => {
        const size = safeNumber(h.sizeUsd);
        const typical = safeNumber(h.typicalPositionUsd);
        if (size === null || typical === null || typical <= 0) return null;
        return size / typical;
      })
      .filter((n): n is number => n !== null);
    if (ratios.length === 0) return null;
    const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    return scaleToScore(avgRatio, 0.5, 3);
  })();

  // Entry alignment: are the tracked traders in at roughly today's price?
  const entryAlignment = gap.score;

  const { baseScore, components } = combineComponents([
    {
      key: "agreement",
      label: "Independent agreement",
      value: agreement,
      weight: cfg.weights.agreement,
      detail: `${qualified.length} qualified trader${qualified.length === 1 ? "" : "s"} on this side, ${qualifiedOpposing.length} opposing`,
    },
    {
      key: "traderQuality",
      label: "Trader quality",
      value: traderQuality,
      weight: cfg.weights.traderQuality,
      detail:
        traderQuality !== null
          ? `Exposure-weighted Smart Trader Score of ${traderQuality.toFixed(0)}`
          : "No trader scores available",
    },
    {
      key: "categorySkill",
      label: "Category skill",
      value: categorySkill,
      weight: cfg.weights.categorySkill,
      detail:
        categorySkill !== null
          ? `Holders' historical skill in this category scores ${categorySkill.toFixed(0)}`
          : "No category track record for these traders",
    },
    {
      key: "recency",
      label: "Recent activity",
      value: recency,
      weight: cfg.weights.recency,
      detail: `${increasingCount} increased and ${decreasingCount} reduced in the last ${cfg.recentActivityHours}h`,
    },
    {
      key: "convictionRelative",
      label: "Relative conviction",
      value: convictionRelative,
      weight: cfg.weights.convictionRelative,
      detail:
        convictionRelative !== null
          ? "Position sizes compared to each trader's own typical size"
          : "Not enough history to compare position sizing",
    },
    {
      key: "entryAlignment",
      label: "Entry alignment",
      value: entryAlignment,
      weight: cfg.weights.entryAlignment,
      detail: gap.entryGap !== null ? gap.label : "No entry price available",
    },
  ]);

  // --- Penalties ------------------------------------------------------------
  const penalties: ScorePenalty[] = [];

  if (topWalletShare !== null && topWalletShare > cfg.oneWalletShareThreshold) {
    penalties.push({
      key: "one-wallet",
      label: "One wallet dominates the signal",
      points: -cfg.oneWalletPenalty,
      detail: `${Math.round(topWalletShare * 100)}% of the weighted signal comes from a single trader, so this is closer to one opinion than a consensus.`,
    });
  }

  // Correlated wallets are not identifiable from any Polymarket API. This is a behavioural
  // approximation: wallets that all opened within a few hours of each other at nearly the same
  // price may be one operator, and are treated as less independent.
  const correlation = detectPossibleCorrelation(unique);
  if (correlation) penalties.push(correlation);

  if (
    medianPositionAgeHours !== null &&
    medianPositionAgeHours > cfg.stalePositionHours
  ) {
    penalties.push({
      key: "stale",
      label: "Stale positions",
      points: -cfg.stalePenalty,
      detail: `The median position here is ${Math.round(medianPositionAgeHours / 24)} days old with no recent additions.`,
    });
  }

  if (gap.entryGap !== null && gap.entryGap > cfg.largeEntryGap) {
    penalties.push({
      key: "entry-gap",
      label: "Traders entered much cheaper",
      points: -cfg.largeEntryGapPenalty,
      detail: `Tracked traders are in at ${((weightedEntry ?? 0) * 100).toFixed(0)}¢ against a market price of ${((market.currentPrice ?? 0) * 100).toFixed(0)}¢. Buying today is a materially different trade.`,
    });
  }

  const liquidity = safeNumber(market.liquidity);
  if (liquidity !== null && liquidity < cfg.lowLiquidityUsd) {
    penalties.push({
      key: "low-liquidity",
      label: "Low liquidity",
      points: -cfg.lowLiquidityPenalty,
      detail: `Only ${usdPlain(liquidity)} of liquidity, which limits how much of this signal is actually executable.`,
    });
  }

  const spread = safeNumber(market.spread);
  if (spread !== null && spread > cfg.wideSpread) {
    penalties.push({
      key: "wide-spread",
      label: "Wide spread",
      points: -cfg.wideSpreadPenalty,
      detail: `The bid-ask spread is ${(spread * 100).toFixed(1)}¢, which is a real cost on entry and exit.`,
    });
  }

  const botCount = unique.filter((h) => h.likelyBot).length;
  if (botCount > 0) {
    const share = botCount / unique.length;
    penalties.push({
      key: "bots",
      label: "Suspected bots or scalpers in the signal",
      points: -Math.round(cfg.botPenalty * share),
      detail: `${botCount} of ${unique.length} holders show automation-like behaviour, so this signal may not be manually replicable.`,
    });
  }

  const result = applyPenalties(baseScore, penalties, components);

  return {
    ...result,
    traderCount: unique.length,
    qualifiedTraderCount: qualified.length,
    opposingTraderCount: uniqueOpposing.length,
    exposureUsd,
    opposingExposureUsd,
    weightedEntryPrice: weightedEntry,
    avgEntryPrice,
    currentPrice: safeNumber(market.currentPrice),
    entryGap: gap.entryGap,
    boughtUsd24h,
    soldUsd24h,
    increasingCount,
    decreasingCount,
    topWalletShare,
    medianPositionAgeHours,
    contributors: weights
      .sort((a, b) => b.weight - a.weight)
      .map(({ holder, weight }) => ({
        traderId: holder.traderId,
        wallet: holder.wallet,
        displayName: holder.displayName,
        smartScore: holder.smartScore,
        sizeUsd: holder.sizeUsd,
        avgPrice: holder.avgPrice,
        weight: Math.round(weight * 100) / 100,
        openedAt: holder.openedAt ? holder.openedAt.toISOString() : null,
        recentNetUsd: holder.recentNetUsd,
      })),
  };
}

/** One entry per wallet, keeping the largest position if a wallet appears more than once. */
function dedupeByWallet(holders: ConsensusHolder[]): ConsensusHolder[] {
  const byWallet = new Map<string, ConsensusHolder>();
  for (const holder of holders) {
    const key = holder.wallet.toLowerCase();
    const existing = byWallet.get(key);
    if (!existing || (safeNumber(holder.sizeUsd) ?? 0) > (safeNumber(existing.sizeUsd) ?? 0)) {
      byWallet.set(key, holder);
    }
  }
  return [...byWallet.values()];
}

/**
 * Approximates correlated wallets. Polymarket exposes nothing that would let us prove two wallets
 * are the same operator, so this looks for a behavioural fingerprint — several positions opened in
 * a tight time window at nearly the same price — and is labelled as an approximation in the UI.
 */
function detectPossibleCorrelation(holders: ConsensusHolder[]): ScorePenalty | null {
  const dated = holders.filter(
    (h) => h.openedAt !== null && safeNumber(h.avgPrice) !== null,
  );
  if (dated.length < 3) return null;

  const sorted = [...dated].sort(
    (a, b) => (a.openedAt as Date).getTime() - (b.openedAt as Date).getTime(),
  );

  let largestCluster = 1;
  for (let i = 0; i < sorted.length; i++) {
    let clusterSize = 1;
    const anchorTime = (sorted[i].openedAt as Date).getTime();
    const anchorPrice = safeNumber(sorted[i].avgPrice) as number;
    for (let j = i + 1; j < sorted.length; j++) {
      const time = (sorted[j].openedAt as Date).getTime();
      const price = safeNumber(sorted[j].avgPrice) as number;
      if (time - anchorTime > 2 * HOUR_MS) break;
      if (Math.abs(price - anchorPrice) <= 0.01) clusterSize++;
    }
    largestCluster = Math.max(largestCluster, clusterSize);
  }

  if (largestCluster < 3) return null;

  return {
    key: "possible-correlation",
    label: "Positions may be correlated",
    points: -Math.min(10, largestCluster * 2),
    detail: `${largestCluster} wallets opened within two hours of each other at nearly the same price. Polymarket does not expose wallet ownership, so this is an approximation, but these may not be independent opinions.`,
  };
}

/** Portfolio-level concentration of a side's exposure, exported for the UI. */
export function exposureConcentration(holders: ConsensusHolder[]): number | null {
  return herfindahl(holders.map((h) => h.sizeUsd));
}
