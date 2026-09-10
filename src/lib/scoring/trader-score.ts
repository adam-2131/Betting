/**
 * SMART TRADER SCORE — 0 to 100.
 *
 * Computed entirely from measurable inputs. No LLM produces any part of this number. Every
 * component and every penalty is returned and rendered, so the score can always be audited.
 *
 * Weights (from config.ts):
 *   25%  long-term realized return performance
 *   20%  consistency
 *   15%  recent performance
 *   15%  category-specific performance
 *   10%  risk-adjusted return
 *   10%  sample size of resolved positions
 *    5%  conviction quality
 *
 * Only RESOLVED positions count toward the track record. Open-position gains are never treated as
 * realized profit — an unrealized winner is a position, not a result.
 *
 * Pure and synchronous; the clock is an argument so the backtest can score a trader as of a past
 * date using only positions that had resolved by then.
 */
import { Category } from "@prisma/client";
import { herfindahl, mean, safeNumber, scaleToScore, stdDev, sum, usdPlain } from "@/lib/num";
import type { ScoringConfig } from "./config";
import { DEFAULT_SCORING_CONFIG, ENTRY_PRICE_BUCKETS, entryBucketFor } from "./config";
import { applyPenalties, combineComponents, type ScorePenalty, type ScoreResult } from "./types";
import type { BehaviorResult } from "./behavior";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A settled position. This is the only thing that counts toward the track record. */
export interface ResolvedPosition {
  conditionId: string;
  category: Category;
  /** Cost basis per share, 0..1. */
  avgPrice: number | null;
  /**
   * USD actually staked (shares × avgPrice).
   *
   * Deliberately NOT the API's `totalBought`, which counts SHARES despite its name. Using that
   * raw would inflate this denominator by 1/avgPrice and make every ROI figure wrong.
   */
  costBasisUsd: number | null;
  realizedPnl: number | null;
  /** null when settlement was not a clean win/loss — excluded from win rate. */
  won: boolean | null;
  resolvedAt: Date | null;
}

export interface OpenPositionSummary {
  currentValue: number | null;
  cashPnl: number | null;
}

export interface TraderScoreInput {
  resolved: ResolvedPosition[];
  open: OpenPositionSummary[];
  portfolioValue: number | null;
  behavior: BehaviorResult | null;
  /** Evaluation clock. Injected so historical scoring is possible without look-ahead. */
  now: Date;
}

export interface MonthlyBucket {
  month: string;
  realizedPnl: number;
  wins: number;
  losses: number;
  staked: number;
  roi: number | null;
}

export interface EntryBucketStat {
  bucket: string;
  label: string;
  count: number;
  wins: number;
  staked: number;
  realizedPnl: number;
  roi: number | null;
  winRate: number | null;
}

export interface CategoryStat {
  category: Category;
  closedCount: number;
  winCount: number;
  winRate: number | null;
  realizedPnl: number;
  totalStaked: number;
  roi: number | null;
  /** 0-100, shrunk toward 50 on small samples. */
  skillScore: number | null;
}

export interface TraderMetrics {
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  totalPnl: number | null;
  portfolioValue: number | null;
  closedCount: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  totalStaked: number | null;
  roi: number | null;
  avgEntryPrice: number | null;
  avgPositionUsd: number | null;
  largestPositionUsd: number | null;
  largestWinUsd: number | null;
  largestLossUsd: number | null;
  roiLast30d: number | null;
  roiLast90d: number | null;
  monthlyWinRate: number | null;
  profitVolatility: number | null;
  riskAdjustedReturn: number | null;
  concentrationHhi: number | null;
  topWinShare: number | null;
  highPriceShare: number | null;
  /**
   * True when the resolved record contains implausibly few losses.
   *
   * Polymarket's /closed-positions is redemption-driven: a losing outcome token is worthless, so
   * a trader who never bothers redeeming it never generates a closed position for it. Wallets
   * that only redeem winners therefore show a flawless record. Verified live — one leaderboard
   * wallet returned 59 closed positions, 59 wins, 0 losses, and exactly 59 REDEEM activities.
   */
  redemptionBiasSuspected: boolean;
  monthly: MonthlyBucket[];
  entryBuckets: EntryBucketStat[];
  categories: CategoryStat[];
  pnlCurve: Array<{ t: string; cumulativePnl: number }>;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Realized PnL / total staked across resolved positions. */
function roiOf(positions: ResolvedPosition[]): number | null {
  const staked = sum(positions.map((p) => p.costBasisUsd));
  const pnl = sum(positions.map((p) => p.realizedPnl));
  return staked > 0 ? pnl / staked : null;
}

export function computeTraderMetrics(input: TraderScoreInput): TraderMetrics {
  const { resolved, open, now } = input;

  // Only positions that actually settled and that we can date are usable for time-series work.
  const decided = resolved.filter((p) => p.won !== null);
  const dated = resolved.filter((p) => p.resolvedAt !== null);

  const realizedPnl = resolved.length > 0 ? sum(resolved.map((p) => p.realizedPnl)) : null;
  const unrealizedPnl = open.length > 0 ? sum(open.map((p) => p.cashPnl)) : null;

  const totalStaked = resolved.length > 0 ? sum(resolved.map((p) => p.costBasisUsd)) : null;
  const winCount = decided.filter((p) => p.won === true).length;
  const lossCount = decided.filter((p) => p.won === false).length;

  const stakes = resolved
    .map((p) => safeNumber(p.costBasisUsd))
    .filter((n): n is number => n !== null && n > 0);

  const pnls = resolved
    .map((p) => safeNumber(p.realizedPnl))
    .filter((n): n is number => n !== null);
  const wins = pnls.filter((n) => n > 0);
  const losses = pnls.filter((n) => n < 0);
  const totalWinnings = sum(wins);

  // --- Monthly buckets ------------------------------------------------------
  const monthlyMap = new Map<string, MonthlyBucket>();
  for (const position of dated) {
    const key = monthKey(position.resolvedAt as Date);
    const bucket = monthlyMap.get(key) ?? {
      month: key,
      realizedPnl: 0,
      wins: 0,
      losses: 0,
      staked: 0,
      roi: null,
    };
    bucket.realizedPnl += safeNumber(position.realizedPnl) ?? 0;
    bucket.staked += safeNumber(position.costBasisUsd) ?? 0;
    if (position.won === true) bucket.wins++;
    else if (position.won === false) bucket.losses++;
    monthlyMap.set(key, bucket);
  }
  const monthly = [...monthlyMap.values()]
    .map((b) => ({ ...b, roi: b.staked > 0 ? b.realizedPnl / b.staked : null }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // --- Entry-price buckets --------------------------------------------------
  const entryBuckets: EntryBucketStat[] = ENTRY_PRICE_BUCKETS.map((definition) => {
    const inBucket = resolved.filter((p) => entryBucketFor(p.avgPrice) === definition.key);
    const staked = sum(inBucket.map((p) => p.costBasisUsd));
    const pnl = sum(inBucket.map((p) => p.realizedPnl));
    const decidedInBucket = inBucket.filter((p) => p.won !== null);
    const bucketWins = decidedInBucket.filter((p) => p.won === true).length;
    return {
      bucket: definition.key,
      label: definition.label,
      count: inBucket.length,
      wins: bucketWins,
      staked,
      realizedPnl: pnl,
      roi: staked > 0 ? pnl / staked : null,
      winRate: decidedInBucket.length > 0 ? bucketWins / decidedInBucket.length : null,
    };
  });

  // --- Per-category ---------------------------------------------------------
  const categoryMap = new Map<Category, ResolvedPosition[]>();
  for (const position of resolved) {
    const list = categoryMap.get(position.category) ?? [];
    list.push(position);
    categoryMap.set(position.category, list);
  }
  const overallRoi = roiOf(resolved);
  const categories: CategoryStat[] = [...categoryMap.entries()].map(([category, positions]) => {
    const decidedHere = positions.filter((p) => p.won !== null);
    const winsHere = decidedHere.filter((p) => p.won === true).length;
    const stakedHere = sum(positions.map((p) => p.costBasisUsd));
    const pnlHere = sum(positions.map((p) => p.realizedPnl));
    const roiHere = stakedHere > 0 ? pnlHere / stakedHere : null;

    return {
      category,
      closedCount: positions.length,
      winCount: winsHere,
      winRate: decidedHere.length > 0 ? winsHere / decidedHere.length : null,
      realizedPnl: pnlHere,
      totalStaked: stakedHere,
      roi: roiHere,
      skillScore: shrinkCategorySkill(roiHere, positions.length, overallRoi),
    };
  });

  // --- Cumulative curve -----------------------------------------------------
  const pnlCurve: Array<{ t: string; cumulativePnl: number }> = [];
  let running = 0;
  for (const position of [...dated].sort(
    (a, b) => (a.resolvedAt as Date).getTime() - (b.resolvedAt as Date).getTime(),
  )) {
    running += safeNumber(position.realizedPnl) ?? 0;
    pnlCurve.push({ t: (position.resolvedAt as Date).toISOString(), cumulativePnl: running });
  }

  // --- Recency --------------------------------------------------------------
  const cutoff30 = new Date(now.getTime() - 30 * DAY_MS);
  const cutoff90 = new Date(now.getTime() - 90 * DAY_MS);
  const roiLast30d = roiOf(dated.filter((p) => (p.resolvedAt as Date) >= cutoff30));
  const roiLast90d = roiOf(dated.filter((p) => (p.resolvedAt as Date) >= cutoff90));

  // --- Consistency ----------------------------------------------------------
  const profitableMonths = monthly.filter((m) => m.realizedPnl > 0).length;
  const monthlyWinRate = monthly.length > 0 ? profitableMonths / monthly.length : null;
  const monthlyRois = monthly.map((m) => m.roi).filter((r): r is number => r !== null);
  const profitVolatility = monthlyRois.length >= 2 ? stdDev(monthlyRois) : null;

  // --- Risk-adjusted --------------------------------------------------------
  const meanMonthlyRoi = mean(monthlyRois);
  const riskAdjustedReturn =
    meanMonthlyRoi !== null && profitVolatility !== null && profitVolatility > 0
      ? meanMonthlyRoi / profitVolatility
      : null;

  // --- Concentration / dominance -------------------------------------------
  const openValues = open.map((p) => p.currentValue);
  const concentrationHhi = herfindahl(openValues);
  const topWinShare =
    totalWinnings > 0 && wins.length > 0 ? Math.max(...wins) / totalWinnings : null;

  const highPricePositions = resolved.filter((p) => {
    const price = safeNumber(p.avgPrice);
    return price !== null && price >= 0.95;
  });
  const highPriceShare =
    resolved.length > 0 ? highPricePositions.length / resolved.length : null;

  return {
    realizedPnl,
    unrealizedPnl,
    totalPnl:
      realizedPnl === null && unrealizedPnl === null ? null : (realizedPnl ?? 0) + (unrealizedPnl ?? 0),
    portfolioValue: safeNumber(input.portfolioValue),
    closedCount: resolved.length,
    winCount,
    lossCount,
    winRate: decided.length > 0 ? winCount / decided.length : null,
    totalStaked,
    roi: roiOf(resolved),
    avgEntryPrice: mean(resolved.map((p) => p.avgPrice)),
    avgPositionUsd: stakes.length > 0 ? sum(stakes) / stakes.length : null,
    largestPositionUsd: stakes.length > 0 ? Math.max(...stakes) : null,
    largestWinUsd: wins.length > 0 ? Math.max(...wins) : null,
    largestLossUsd: losses.length > 0 ? Math.min(...losses) : null,
    roiLast30d,
    roiLast90d,
    monthlyWinRate,
    profitVolatility,
    riskAdjustedReturn,
    concentrationHhi,
    topWinShare,
    highPriceShare,
    // A real trader with a double-digit resolved record essentially always has some losses.
    redemptionBiasSuspected: decided.length >= 10 && lossCount === 0,
    monthly,
    entryBuckets,
    categories,
    pnlCurve,
  };
}

/**
 * Category skill, shrunk toward the trader's overall performance on small samples.
 * Three winning politics bets does not make somebody a politics expert.
 */
function shrinkCategorySkill(
  categoryRoi: number | null,
  sampleSize: number,
  overallRoi: number | null,
  priorWeight = DEFAULT_SCORING_CONFIG.traderScore.categoryPriorWeight,
): number | null {
  if (categoryRoi === null) return null;
  const prior = overallRoi ?? 0;
  const shrunk = (categoryRoi * sampleSize + prior * priorWeight) / (sampleSize + priorWeight);
  return scaleToScore(shrunk, -0.5, 1.0);
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export interface TraderScoreResult extends ScoreResult {
  metrics: TraderMetrics;
}

export function computeTraderScore(
  input: TraderScoreInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): TraderScoreResult {
  const metrics = computeTraderMetrics(input);
  const cfg = config.traderScore;
  const weights = cfg.weights;

  // --- 25% long-term realized return ---------------------------------------
  const longTerm = scaleToScore(metrics.roi, cfg.roiScoreRange[0], cfg.roiScoreRange[1]);

  // --- 20% consistency: profitable months, penalised for volatility ---------
  let consistency: number | null = null;
  if (metrics.monthlyWinRate !== null && metrics.monthly.length >= 2) {
    const base = metrics.monthlyWinRate * 100;
    // High month-to-month ROI dispersion means the record is luck-shaped.
    const volatilityDrag =
      metrics.profitVolatility !== null ? Math.min(25, metrics.profitVolatility * 25) : 0;
    consistency = Math.max(0, base - volatilityDrag);
  } else if (metrics.winRate !== null && metrics.closedCount >= 5) {
    // Not enough months for a time series; fall back to raw win rate, discounted.
    consistency = metrics.winRate * 80;
  }

  // --- 15% recent performance ----------------------------------------------
  const recentRoi = metrics.roiLast30d ?? metrics.roiLast90d;
  const recentForm = scaleToScore(recentRoi, -0.5, 1.0);

  // --- 15% category-specific performance -----------------------------------
  // Exposure-weighted average of per-category skill, so a trader's main arena dominates.
  const categorySkill = (() => {
    const scored = metrics.categories.filter((c) => c.skillScore !== null && c.totalStaked > 0);
    if (scored.length === 0) return null;
    const totalStaked = scored.reduce((acc, c) => acc + c.totalStaked, 0);
    if (totalStaked <= 0) return null;
    return scored.reduce((acc, c) => acc + (c.skillScore as number) * (c.totalStaked / totalStaked), 0);
  })();

  // --- 10% risk-adjusted return --------------------------------------------
  const riskAdjusted = scaleToScore(metrics.riskAdjustedReturn, -1, 3);

  // --- 10% sample size ------------------------------------------------------
  // sqrt so the curve is steep early and flattens out; 50 resolved positions is full credit.
  const sampleQuality =
    metrics.closedCount > 0
      ? Math.min(100, Math.sqrt(metrics.closedCount / cfg.minSampleForFullCredit) * 100)
      : 0;

  // --- 5% conviction quality ------------------------------------------------
  // Rewards being willing to size up on the winners rather than spraying equal tickets.
  const conviction = (() => {
    const decided = input.resolved.filter((p) => p.won !== null && (safeNumber(p.costBasisUsd) ?? 0) > 0);
    if (decided.length < 5) return null;
    const winStakes = decided.filter((p) => p.won === true).map((p) => safeNumber(p.costBasisUsd) ?? 0);
    const lossStakes = decided.filter((p) => p.won === false).map((p) => safeNumber(p.costBasisUsd) ?? 0);
    const avgWinStake = mean(winStakes);
    const avgLossStake = mean(lossStakes);
    if (avgWinStake === null || avgLossStake === null || avgLossStake <= 0) return null;
    // 1.0 = sizes winners and losers identically; 2.0 = winners are twice the size.
    return scaleToScore(avgWinStake / avgLossStake, 0.5, 2.0);
  })();

  const { baseScore, components } = combineComponents([
    {
      key: "longTerm",
      label: "Long-term performance",
      value: longTerm,
      weight: weights.longTerm,
      detail:
        metrics.roi !== null
          ? `${(metrics.roi * 100).toFixed(1)}% return on ${usdPlain(metrics.totalStaked ?? 0)} staked across ${metrics.closedCount} resolved positions`
          : "No resolved positions yet",
    },
    {
      key: "consistency",
      label: "Consistency",
      value: consistency,
      weight: weights.consistency,
      detail:
        metrics.monthlyWinRate !== null
          ? `Profitable in ${Math.round(metrics.monthlyWinRate * 100)}% of ${metrics.monthly.length} active months`
          : "Not enough months of history",
    },
    {
      key: "recentForm",
      label: "Recent form",
      value: recentForm,
      weight: weights.recentForm,
      detail:
        recentRoi !== null
          ? `${(recentRoi * 100).toFixed(1)}% return on positions resolved in the last ${metrics.roiLast30d !== null ? 30 : 90} days`
          : "Nothing resolved recently",
    },
    {
      key: "categorySkill",
      label: "Category skill",
      value: categorySkill,
      weight: weights.categorySkill,
      detail:
        metrics.categories.length > 0
          ? `Weighted across ${metrics.categories.length} categories`
          : "No category history",
    },
    {
      key: "riskAdjusted",
      label: "Risk-adjusted return",
      value: riskAdjusted,
      weight: weights.riskAdjusted,
      detail:
        metrics.riskAdjustedReturn !== null
          ? `Mean monthly return divided by its volatility: ${metrics.riskAdjustedReturn.toFixed(2)}`
          : "Not enough months to measure volatility",
    },
    {
      key: "sampleQuality",
      label: "Sample quality",
      value: sampleQuality,
      weight: weights.sampleQuality,
      detail: `${metrics.closedCount} resolved positions (${cfg.minSampleForFullCredit} needed for full credit)`,
    },
    {
      key: "conviction",
      label: "Conviction",
      value: conviction,
      weight: weights.conviction,
      detail:
        conviction !== null
          ? "Compares average stake on winners against average stake on losers"
          : "Not enough resolved positions to measure sizing",
    },
  ]);

  const penalties = computeTraderPenalties(metrics, input.behavior, config);
  const result = applyPenalties(baseScore, penalties, components);

  return { ...result, metrics };
}

function computeTraderPenalties(
  metrics: TraderMetrics,
  behavior: BehaviorResult | null,
  config: ScoringConfig,
): ScorePenalty[] {
  const cfg = config.traderScore;
  const penalties: ScorePenalty[] = [];

  if (metrics.closedCount < cfg.smallSampleThreshold) {
    // Scale the hit so 9 resolved positions is not treated the same as 1.
    const severity = 1 - metrics.closedCount / cfg.smallSampleThreshold;
    penalties.push({
      key: "small-sample",
      label: "Very small sample size",
      points: -Math.round(cfg.smallSamplePenalty * severity),
      detail: `Only ${metrics.closedCount} resolved positions. A track record this short cannot separate skill from luck.`,
    });
  }

  if (metrics.concentrationHhi !== null && metrics.concentrationHhi > cfg.concentrationThreshold) {
    penalties.push({
      key: "concentration",
      label: "High concentration",
      points: -cfg.concentrationPenalty,
      detail: `Open positions are heavily concentrated (HHI ${metrics.concentrationHhi.toFixed(2)}), so results depend on a small number of outcomes.`,
    });
  }

  if (metrics.redemptionBiasSuspected) {
    penalties.push({
      key: "redemption-bias",
      label: "Record appears to contain only winners",
      points: -cfg.redemptionBiasPenalty,
      detail: `All ${metrics.winCount} resolved positions won and none lost. Polymarket only reports a closed position once its tokens are redeemed, and worthless losing tokens are often left unredeemed — so this is very likely an incomplete record rather than a perfect one. The win rate and ROI above should not be taken at face value.`,
    });
  }

  if (metrics.highPriceShare !== null && metrics.highPriceShare > cfg.highPriceShareThreshold) {
    penalties.push({
      key: "high-price",
      label: "Primarily 95–99¢ trades",
      points: -cfg.highPricePenalty,
      detail: `${Math.round(metrics.highPriceShare * 100)}% of resolved positions were entered above 95¢. A high win rate on near-certain outcomes is not forecasting skill.`,
    });
  }

  const medianHold = behavior?.metrics.medianHoldSeconds ?? null;
  if (medianHold !== null && medianHold < cfg.shortHoldSecondsThreshold) {
    penalties.push({
      key: "short-hold",
      label: "Extremely short holding periods",
      points: -cfg.shortHoldPenalty,
      detail: `Median holding period is under ${Math.round(cfg.shortHoldSecondsThreshold / 60)} minutes, which is not a signal a manual trader can act on.`,
    });
  }

  if (metrics.topWinShare !== null && metrics.topWinShare > cfg.oneWinDominanceThreshold) {
    penalties.push({
      key: "one-win",
      label: "Performance dominated by one win",
      points: -cfg.oneWinDominancePenalty,
      detail: `${Math.round(metrics.topWinShare * 100)}% of all profit came from a single position.`,
    });
  }

  if (metrics.roiLast30d !== null && metrics.roiLast30d < cfg.poorRecentRoiThreshold) {
    penalties.push({
      key: "poor-recent",
      label: "Poor recent performance",
      points: -cfg.poorRecentFormPenalty,
      detail: `Positions resolved in the last 30 days returned ${(metrics.roiLast30d * 100).toFixed(1)}%.`,
    });
  }

  if (behavior && behavior.confidence !== "low") {
    if (behavior.classification === "MARKET_MAKER") {
      penalties.push({
        key: "market-maker",
        label: "Behaviour consistent with market making",
        points: -cfg.marketMakerPenalty,
        detail: "Profits may come from spread capture rather than from forecasting outcomes.",
      });
    } else if (behavior.classification === "POSSIBLE_BOT" || behavior.classification === "SCALPER") {
      penalties.push({
        key: "bot",
        label: `Behaviour consistent with ${behavior.classification === "SCALPER" ? "scalping" : "automation"}`,
        points: -cfg.botPenalty,
        detail: "Trading pattern suggests signals that a manual trader could not realistically replicate.",
      });
    }
  }

  return penalties;
}
