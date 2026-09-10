/**
 * OPPORTUNITY SCORE — 0 to 100.
 *
 * Answers a narrower question than "is this a good market": is this signal still worth acting on
 * AT TODAY'S PRICE?
 *
 *   30%  Smart Money Consensus
 *   20%  Trader Quality
 *   15%  Entry Quality
 *   10%  Liquidity
 *   10%  Spread / execution quality
 *   10%  Recency of smart-money activity
 *    5%  Market / resolution clarity
 *
 * This is the exact function the backtest replays, with point-in-time inputs. There is no separate
 * "historical" implementation that could drift from the live one.
 *
 * Pure and synchronous.
 */
import { Category } from "@prisma/client";
import { intPlain, safeNumber, scaleToScore, usdPlain } from "@/lib/num";
import type { ScoringConfig } from "./config";
import { DEFAULT_SCORING_CONFIG } from "./config";
import { AMBIGUOUS_CLARITY_THRESHOLD } from "./clarity";
import { analyzeEntryGap, type EntryGapResult } from "./entry-gap";
import { calculateExpectedValue, payoutPerDollar, type PayoutResult } from "./payout";
import { applyPenalties, combineComponents, type ScorePenalty, type ScoreResult } from "./types";
import type { ConsensusResult } from "./consensus";

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "VERY HIGH";

export interface OpportunityMarketInput {
  conditionId: string;
  question: string;
  category: Category;
  outcomeIndex: number;
  outcomeLabel: string;
  currentPrice: number | null;
  liquidity: number | null;
  spread: number | null;
  volume24hr: number | null;
  endDate: Date | null;
  clarityScore: number | null;
  clarityFlags: string[];
  /** True when a suspected bot/scalper contributes to this side's signal. */
  hasBotContributors: boolean;
  /** Hours since the most recent tracked-trader activity on this side. */
  hoursSinceLastActivity: number | null;
}

export interface ModelEstimate {
  low: number | null;
  mid: number | null;
  high: number | null;
  /** Estimated edge in percentage points versus the market price. */
  edgePoints: number | null;
  evPerShare: number | null;
  returnOnCapital: number | null;
  /** Always shown next to the number. */
  caveat: string;
}

export interface OpportunityResult extends ScoreResult {
  currentPrice: number | null;
  entryGap: EntryGapResult;
  payout: PayoutResult;
  modelEstimate: ModelEstimate;
  riskLevel: RiskLevel;
  riskReasons: string[];
  reasonsFor: string[];
  reasonsAgainst: string[];
  hoursUntilResolution: number | null;
}

const HOUR_MS = 3_600_000;

/** Logarithmic, because the difference between $2k and $20k matters far more than $200k to $500k. */
function liquidityScore(liquidity: number | null, range: [number, number]): number | null {
  const value = safeNumber(liquidity);
  if (value === null) return null;
  if (value <= 0) return 0;
  const [min, max] = range;
  const logValue = Math.log10(Math.max(value, 1));
  const logMin = Math.log10(Math.max(min, 1));
  const logMax = Math.log10(Math.max(max, 10));
  return scaleToScore(logValue, logMin, logMax);
}

/** Inverted: a tighter spread scores higher. */
function executionScore(spread: number | null, range: [number, number]): number | null {
  const value = safeNumber(spread);
  if (value === null) return null;
  const [tight, wide] = range;
  const scaled = scaleToScore(value, tight, wide);
  return scaled === null ? null : 100 - scaled;
}

/**
 * MODEL ESTIMATE.
 *
 * Deliberately NOT an LLM guess at the true probability. It is a bounded, quantitative nudge away
 * from the market price in the direction the smart money is leaning, sized by consensus strength
 * and capped hard. It is always presented as a range with an explicit caveat.
 *
 * The market price is the prior; smart-money agreement is weak evidence against it, not a
 * replacement for it.
 */
export function computeModelEstimate(
  currentPrice: number | null,
  consensus: ConsensusResult | null,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ModelEstimate {
  const cfg = config.modelEstimate;
  const price = safeNumber(currentPrice);
  const caveat =
    "This is a model estimate derived from smart-money positioning, not a measured probability. It is not a guaranteed edge.";

  if (price === null || price <= 0 || price >= 1 || !consensus || consensus.qualifiedTraderCount === 0) {
    return {
      low: null,
      mid: null,
      high: null,
      edgePoints: null,
      evPerShare: null,
      returnOnCapital: null,
      caveat,
    };
  }

  // Consensus strength above the neutral midpoint drives the size of the shift.
  const strength = Math.max(0, (consensus.score - 50) / 50); // 0..1
  const rawShift = strength * cfg.maxShiftFraction * (1 - price);
  const shift = Math.min(rawShift, cfg.maxShiftAbsolute);

  const mid = Math.max(0.01, Math.min(0.99, price + shift));

  // Uncertainty widens when few traders back the signal.
  const missingTraders = Math.max(0, 6 - consensus.qualifiedTraderCount);
  const uncertainty = Math.min(
    cfg.maxUncertainty,
    Math.max(cfg.minUncertainty, cfg.baseUncertainty + missingTraders * cfg.uncertaintyPerMissingTrader),
  );

  const ev = calculateExpectedValue(mid, price);

  return {
    low: Math.max(0.01, mid - uncertainty),
    high: Math.min(0.99, mid + uncertainty),
    mid,
    edgePoints: ev.edgePoints,
    evPerShare: ev.evPerShare,
    returnOnCapital: ev.returnOnCapital,
    caveat,
  };
}

function assessRisk(
  market: OpportunityMarketInput,
  hoursUntilResolution: number | null,
  config: ScoringConfig,
): { level: RiskLevel; reasons: string[] } {
  const cfg = config.risk;
  const reasons: string[] = [];
  let points = 0;

  const price = safeNumber(market.currentPrice);
  if (price !== null && price < cfg.longshotPrice) {
    points += 2;
    reasons.push(`At ${(price * 100).toFixed(0)}¢ the market considers this unlikely; most such positions lose.`);
  } else if (price !== null && price < 0.35) {
    points += 1;
    reasons.push(`At ${(price * 100).toFixed(0)}¢ this is priced as an underdog outcome.`);
  }

  const liquidity = safeNumber(market.liquidity);
  if (liquidity !== null && liquidity < cfg.thinLiquidityUsd) {
    points += 1;
    reasons.push(`Liquidity of ${usdPlain(liquidity)} may make entry or exit difficult.`);
  }

  if (hoursUntilResolution !== null && hoursUntilResolution < cfg.imminentResolutionHours) {
    points += 1;
    reasons.push(`Resolves in under ${Math.max(1, Math.round(hoursUntilResolution))} hours, leaving no time for the thesis to develop.`);
  }

  if (market.clarityScore !== null && market.clarityScore < AMBIGUOUS_CLARITY_THRESHOLD) {
    points += 1;
    reasons.push("Resolution criteria scan as ambiguous, which adds settlement risk.");
  }

  const level: RiskLevel = points >= 4 ? "VERY HIGH" : points >= 2 ? "HIGH" : points >= 1 ? "MODERATE" : "LOW";
  if (reasons.length === 0) {
    reasons.push("Priced near even money with adequate liquidity and clear criteria.");
  }
  return { level, reasons };
}

export function computeOpportunityScore(
  market: OpportunityMarketInput,
  consensus: ConsensusResult,
  now: Date,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): OpportunityResult {
  const cfg = config.opportunity;
  const price = safeNumber(market.currentPrice);

  const entryGap = analyzeEntryGap(price, consensus.weightedEntryPrice, config);
  const payout = payoutPerDollar(price);
  const modelEstimate = computeModelEstimate(price, consensus, config);

  const hoursUntilResolution = market.endDate
    ? (market.endDate.getTime() - now.getTime()) / HOUR_MS
    : null;

  // --- Components -----------------------------------------------------------
  const consensusComponent = consensus.score;

  const traderQualityComponent =
    consensus.components.find((c) => c.key === "traderQuality")?.value ?? null;

  const liquidityComponent = liquidityScore(market.liquidity, cfg.liquidityRange);
  const executionComponent = executionScore(market.spread, cfg.spreadRange);

  const recencyComponent =
    market.hoursSinceLastActivity !== null
      ? Math.max(0, 100 - (market.hoursSinceLastActivity / (cfg.staleSignalHours || 1)) * 100)
      : (consensus.components.find((c) => c.key === "recency")?.value ?? null);

  const clarityComponent = safeNumber(market.clarityScore);

  const { baseScore, components } = combineComponents([
    {
      key: "consensus",
      label: "Smart money consensus",
      value: consensusComponent,
      weight: cfg.weights.consensus,
      detail: `${consensus.qualifiedTraderCount} qualified trader${consensus.qualifiedTraderCount === 1 ? "" : "s"} on this side`,
    },
    {
      key: "traderQuality",
      label: "Trader quality",
      value: traderQualityComponent,
      weight: cfg.weights.traderQuality,
      detail:
        traderQualityComponent !== null
          ? `Exposure-weighted Smart Trader Score of ${traderQualityComponent.toFixed(0)}`
          : "No trader scores available",
    },
    {
      key: "entryQuality",
      label: "Entry quality",
      value: entryGap.score,
      weight: cfg.weights.entryQuality,
      detail: entryGap.label,
    },
    {
      key: "liquidity",
      label: "Liquidity",
      value: liquidityComponent,
      weight: cfg.weights.liquidity,
      detail:
        market.liquidity !== null
          ? `${usdPlain(market.liquidity)} available`
          : "Liquidity unavailable",
    },
    {
      key: "execution",
      label: "Execution quality",
      value: executionComponent,
      weight: cfg.weights.execution,
      detail:
        market.spread !== null ? `${(market.spread * 100).toFixed(1)}¢ spread` : "Spread unavailable",
    },
    {
      key: "recency",
      label: "Recent smart-money activity",
      value: recencyComponent,
      weight: cfg.weights.recency,
      detail:
        market.hoursSinceLastActivity !== null
          ? `Last tracked activity ${Math.round(market.hoursSinceLastActivity)}h ago`
          : "No recent tracked activity recorded",
    },
    {
      key: "clarity",
      label: "Resolution clarity",
      value: clarityComponent,
      weight: cfg.weights.clarity,
      detail:
        market.clarityFlags.length > 0
          ? market.clarityFlags[0]
          : "Resolution criteria scan as objective",
    },
  ]);

  // --- Penalties ------------------------------------------------------------
  const penalties: ScorePenalty[] = [];

  const liquidity = safeNumber(market.liquidity);
  if (liquidity !== null && liquidity < cfg.minLiquidityUsd) {
    penalties.push({
      key: "low-liquidity",
      label: "Very low liquidity",
      points: -cfg.lowLiquidityPenalty,
      detail: `${usdPlain(liquidity)} of liquidity is below the ${usdPlain(cfg.minLiquidityUsd)} threshold where a position can be entered and exited reliably.`,
    });
  }

  const spread = safeNumber(market.spread);
  if (spread !== null && spread > cfg.maxAcceptableSpread) {
    penalties.push({
      key: "wide-spread",
      label: "Very wide spread",
      points: -cfg.wideSpreadPenalty,
      detail: `A ${(spread * 100).toFixed(1)}¢ spread is an immediate cost that has to be recovered before the position is profitable.`,
    });
  }

  if (
    market.hoursSinceLastActivity !== null &&
    market.hoursSinceLastActivity > cfg.staleSignalHours
  ) {
    penalties.push({
      key: "stale",
      label: "Stale smart-money positions",
      points: -cfg.staleSignalPenalty,
      detail: `No tracked trader has adjusted this position in ${Math.round(market.hoursSinceLastActivity / 24)} days.`,
    });
  }

  if (entryGap.entryGap !== null && entryGap.entryGap > cfg.entryGapPenaltyStart) {
    const excess = entryGap.entryGap - cfg.entryGapPenaltyStart;
    const points = Math.min(cfg.maxEntryGapPenalty, excess * cfg.entryGapPenaltyPerDollar);
    penalties.push({
      key: "entry-gap",
      label: "Large entry gap",
      points: -Math.round(points * 10) / 10,
      detail: `The market is ${(entryGap.entryGap * 100).toFixed(1)}¢ above the tracked traders' weighted entry, so you would be buying a materially worse version of their trade.`,
    });
  }

  if (
    consensus.topWalletShare !== null &&
    consensus.topWalletShare > cfg.oneWalletShareThreshold
  ) {
    penalties.push({
      key: "one-wallet",
      label: "One-wallet dominance",
      points: -cfg.oneWalletPenalty,
      detail: `${Math.round(consensus.topWalletShare * 100)}% of the signal comes from a single wallet.`,
    });
  }

  if (market.clarityScore !== null && market.clarityScore < AMBIGUOUS_CLARITY_THRESHOLD) {
    penalties.push({
      key: "ambiguous",
      label: "Ambiguous resolution criteria",
      points: -cfg.ambiguousResolutionPenalty,
      detail:
        market.clarityFlags[0] ??
        "The resolution criteria contain subjective language, which adds settlement risk.",
    });
  }

  if (hoursUntilResolution !== null && hoursUntilResolution < cfg.shortTimeRemainingHours) {
    penalties.push({
      key: "short-time",
      label: "Very little time remaining",
      points: -cfg.shortTimeRemainingPenalty,
      detail: `This market resolves in about ${Math.max(1, Math.round(hoursUntilResolution))} hours.`,
    });
  }

  if (consensus.qualifiedTraderCount < cfg.minQualifiedTraders) {
    // Zero is categorically different from "a few". With no qualified trader on this side there
    // is no smart-money signal at all, and the whole premise of the ranking is absent — good
    // liquidity and a tight spread must not be able to carry such a market up the list.
    const isZero = consensus.qualifiedTraderCount === 0;
    penalties.push({
      key: "insufficient-sample",
      label: isZero ? "No qualified traders on this side" : "Insufficient trader sample",
      points: -(isZero ? cfg.noQualifiedTraderPenalty : cfg.insufficientSamplePenalty),
      detail: isZero
        ? `No tracked trader meeting the quality bar holds this side. There is no smart-money signal here — the score reflects market mechanics only.`
        : `Only ${consensus.qualifiedTraderCount} qualified trader${consensus.qualifiedTraderCount === 1 ? " holds" : "s hold"} this side, which is below the ${cfg.minQualifiedTraders} needed to call it a consensus.`,
    });
  }

  const result = applyPenalties(baseScore, penalties, components);
  const risk = assessRisk(market, hoursUntilResolution, config);

  return {
    ...result,
    currentPrice: price,
    entryGap,
    payout,
    modelEstimate,
    riskLevel: risk.level,
    riskReasons: risk.reasons,
    reasonsFor: buildReasonsFor(market, consensus, entryGap),
    reasonsAgainst: buildReasonsAgainst(market, consensus, entryGap, result.penalties),
    hoursUntilResolution,
  };
}

/**
 * "Why it is interesting" — factual statements drawn from the computed inputs.
 * No hype language: nothing here says guaranteed, easy, or sure.
 */
function buildReasonsFor(
  market: OpportunityMarketInput,
  consensus: ConsensusResult,
  entryGap: EntryGapResult,
): string[] {
  const reasons: string[] = [];

  if (consensus.qualifiedTraderCount > 0) {
    reasons.push(
      `${consensus.qualifiedTraderCount} tracked trader${consensus.qualifiedTraderCount === 1 ? "" : "s"} with strong historical records hold ${market.outcomeLabel} here, against ${consensus.opposingTraderCount} on the other side.`,
    );
  }

  if (consensus.increasingCount > 0) {
    reasons.push(
      `${consensus.increasingCount} of them increased their position in the last 24 hours, adding ${usdPlain(consensus.boughtUsd24h)}.`,
    );
  }

  if (entryGap.quality === "GOOD" || entryGap.quality === "FAIR") {
    reasons.push(
      `The current price is still close to the tracked traders' weighted entry of ${((entryGap.weightedEntryPrice ?? 0) * 100).toFixed(0)}¢, so today's trade resembles theirs.`,
    );
  }

  const categorySkill = consensus.components.find((c) => c.key === "categorySkill")?.value;
  if (categorySkill !== null && categorySkill !== undefined && categorySkill >= 65) {
    reasons.push(
      `The traders on this side have an above-average record specifically in ${market.category.toLowerCase()} markets.`,
    );
  }

  if (market.liquidity !== null && market.liquidity >= 50_000) {
    reasons.push(
      `Liquidity of ${usdPlain(market.liquidity)} is sufficient to enter and exit a small position without moving the price.`,
    );
  }

  if (consensus.exposureUsd > 0) {
    reasons.push(
      `Tracked capital on this side totals ${usdPlain(consensus.exposureUsd)}, against ${usdPlain(consensus.opposingExposureUsd)} opposing.`,
    );
  }

  return reasons.length > 0
    ? reasons
    : ["No positive factors of note. This opportunity is ranked on weak evidence."];
}

/** "Why it could fail" — always populated, including the standing caveats. */
function buildReasonsAgainst(
  market: OpportunityMarketInput,
  consensus: ConsensusResult,
  entryGap: EntryGapResult,
  penalties: ScorePenalty[],
): string[] {
  const reasons: string[] = [];

  // Every applied penalty is a concrete reason this could fail.
  for (const penalty of penalties) {
    reasons.push(penalty.detail);
  }

  if (entryGap.quality === "POOR" || entryGap.quality === "STALE") {
    reasons.push(entryGap.explanation);
  }

  if (market.hasBotContributors) {
    reasons.push(
      "Part of this signal comes from wallets whose behaviour looks automated, which may not be replicable manually.",
    );
  }

  // Standing caveats that apply to every signal in the product.
  reasons.push(
    "Tracked traders may be correlated with each other in ways no public API exposes, so apparent agreement can be a single opinion.",
    "News can reprice a market faster than this dashboard's sync interval.",
    "Resolution criteria can be interpreted in ways that surprise both sides.",
    "Historically strong traders are still frequently wrong, and past performance does not carry forward.",
  );

  return reasons;
}
