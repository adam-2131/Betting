/**
 * Every scoring weight, threshold and penalty in PolyAlpha lives here.
 *
 * Nothing in this file is AI-generated or opaque. Each number is a deliberate, editable choice, and
 * the UI renders the resulting components and penalties individually so a score can always be
 * traced back to its inputs.
 *
 * Runtime overrides come from `AppSettings.scoringOverrides` (Settings page) and are merged over
 * these defaults by `resolveScoringConfig()`.
 */

export interface TraderScoreWeights {
  longTerm: number;
  consistency: number;
  recentForm: number;
  categorySkill: number;
  riskAdjusted: number;
  sampleQuality: number;
  conviction: number;
}

export interface ConsensusWeights {
  agreement: number;
  traderQuality: number;
  categorySkill: number;
  recency: number;
  convictionRelative: number;
  entryAlignment: number;
}

export interface OpportunityWeights {
  consensus: number;
  traderQuality: number;
  entryQuality: number;
  liquidity: number;
  execution: number;
  recency: number;
  clarity: number;
}

export interface ShortHorizonWeights {
  /** Expected return per day of capital tied up, priced at the ask. */
  capitalEfficiency: number;
  /** Whether the edge survives the pessimistic end of the model's own uncertainty band. */
  downsideTested: number;
  /** Strength of the smart-money signal underneath the trade. */
  signalConfidence: number;
  /** How much of the theoretical edge is left after crossing the spread, and how deep the book is. */
  executability: number;
  /** How confidently we know when this settles and on what criteria. */
  settlementCertainty: number;
}

export interface ScoringConfig {
  traderScore: {
    weights: TraderScoreWeights;
    /** Resolved positions needed before the sample-size penalty stops applying. */
    minSampleForFullCredit: number;
    /** Below this, a hard small-sample penalty applies. */
    smallSampleThreshold: number;
    smallSamplePenalty: number;
    /** ROI mapped onto 0-100 across this range. -50%..+150%. */
    roiScoreRange: [number, number];
    /** Portfolio HHI above which concentration is penalised. */
    concentrationThreshold: number;
    concentrationPenalty: number;
    /** Share of resolved positions entered above 0.95 that triggers the favourite-farming penalty. */
    highPriceShareThreshold: number;
    highPricePenalty: number;
    /**
     * Applied when a resolved record contains zero losses, which indicates Polymarket's
     * redemption-driven closed-position reporting rather than a flawless trader.
     */
    redemptionBiasPenalty: number;
    /** Median holding period below which the trader looks like a scalper. */
    shortHoldSecondsThreshold: number;
    shortHoldPenalty: number;
    /** Share of total profit from the single best win. */
    oneWinDominanceThreshold: number;
    oneWinDominancePenalty: number;
    /** 30d ROI below this is treated as poor recent form. */
    poorRecentRoiThreshold: number;
    poorRecentFormPenalty: number;
    marketMakerPenalty: number;
    botPenalty: number;
    /** Bayesian shrinkage prior for per-category win rate. */
    categoryPriorWeight: number;
  };

  behavior: {
    /** Trades in the last 7 days that suggest automation. */
    highFrequency7d: number;
    veryHighFrequency7d: number;
    /** Median holding period below which behaviour looks like scalping. */
    scalperMedianHoldSeconds: number;
    /** Share of positions held all the way to resolution. */
    lowHeldToResolutionPct: number;
    /** Number of markets where the wallet held both YES and NO. */
    marketMakerBothSidesCount: number;
    /** Share of trades under this notional that counts as "small repeated trades". */
    smallTradeUsd: number;
    smallTradeShareThreshold: number;
    /** Turnover = notional traded / portfolio value. */
    highTurnoverRatio: number;
  };

  consensus: {
    weights: ConsensusWeights;
    /** Trader Score at or above this counts a trader as "qualified". */
    qualifiedTraderScore: number;
    /** Agreement component saturates at this many qualified traders. */
    agreementSaturation: number;
    /** Positions older than this are treated as stale. */
    stalePositionHours: number;
    stalePenalty: number;
    /** Single-wallet share of weighted exposure that triggers the one-wallet penalty. */
    oneWalletShareThreshold: number;
    oneWalletPenalty: number;
    /** Entry gap (absolute price) beyond which the position is "much cheaper than today". */
    largeEntryGap: number;
    largeEntryGapPenalty: number;
    lowLiquidityUsd: number;
    lowLiquidityPenalty: number;
    wideSpread: number;
    wideSpreadPenalty: number;
    botPenalty: number;
    /** Recent-activity window for the accumulation signal. */
    recentActivityHours: number;
  };

  opportunity: {
    weights: OpportunityWeights;
    /** Liquidity mapped onto 0-100 logarithmically between these bounds. */
    liquidityRange: [number, number];
    /** Spread mapped onto 0-100, inverted: tighter is better. */
    spreadRange: [number, number];
    minLiquidityUsd: number;
    lowLiquidityPenalty: number;
    maxAcceptableSpread: number;
    wideSpreadPenalty: number;
    staleSignalHours: number;
    staleSignalPenalty: number;
    entryGapPenaltyStart: number;
    /** Penalty points per full dollar of entry gap beyond the start threshold. */
    entryGapPenaltyPerDollar: number;
    maxEntryGapPenalty: number;
    oneWalletShareThreshold: number;
    oneWalletPenalty: number;
    ambiguousResolutionPenalty: number;
    /** Markets resolving sooner than this are penalised for execution risk. */
    shortTimeRemainingHours: number;
    shortTimeRemainingPenalty: number;
    minQualifiedTraders: number;
    insufficientSamplePenalty: number;
    /**
     * Applied when NO qualified trader holds the side. Much larger than the
     * insufficient-sample penalty: without smart-money backing there is no signal to rank, and
     * strong liquidity alone must not float a market to the top of the list.
     */
    noQualifiedTraderPenalty: number;
  };

  /**
   * Hard gate on what is even allowed onto the Opportunities list, applied when the sync writes
   * rows rather than when the UI reads them.
   *
   * This is deliberately separate from the score penalties above. A penalty says "this is a worse
   * opportunity"; eligibility says "this is not an opportunity at all". A side that no qualified
   * trader holds has no smart-money signal to rank, and a market trading at a tenth of a cent
   * cannot be entered in any meaningful size — listing either as a ranked opportunity would bury
   * the real signals under thousands of rows.
   *
   * The soft filters the user sets in Settings (minimum score, minimum liquidity, and so on) are
   * applied on read, so they stay adjustable without a resync.
   */
  eligibility: {
    /** A side needs at least this many qualified traders to be listed at all. */
    minQualifiedTradersToList: number;
    /** Prices outside this band are excluded as untradeable. */
    minListedPrice: number;
    maxListedPrice: number;
  };

  entryGap: {
    /** |gap| at or below this is a good entry. */
    goodThreshold: number;
    /** |gap| at or below this is acceptable. */
    fairThreshold: number;
    /** Above `fairThreshold` and below this is poor; beyond it, the signal is likely stale. */
    poorThreshold: number;
  };

  modelEstimate: {
    /**
     * How far the model is allowed to move away from the market price, as a fraction of the gap
     * between market price and the smart-money implied probability. Deliberately conservative:
     * the market is usually right.
     */
    maxShiftFraction: number;
    /** Hard cap on the probability shift, in probability points. */
    maxShiftAbsolute: number;
    /** Base half-width of the uncertainty band. */
    baseUncertainty: number;
    /** Extra uncertainty when few traders are involved. */
    uncertaintyPerMissingTrader: number;
    minUncertainty: number;
    maxUncertainty: number;
  };

  risk: {
    /** Price below this is a longshot: high risk regardless of everything else. */
    longshotPrice: number;
    /** Liquidity below this raises risk one level. */
    thinLiquidityUsd: number;
    /** Hours to resolution below this raises risk one level. */
    imminentResolutionHours: number;
  };

  /**
   * SHORT-HORIZON scoring — the "what pays out in the next few days" ranking.
   *
   * Separate from `opportunity` because it answers a different question. The opportunity score
   * asks whether a signal is worth acting on at today's price and is deliberately horizon-blind;
   * this asks how much return a dollar earns per day it stays locked up. The two disagree often,
   * and on purpose: `opportunity.shortTimeRemainingPenalty` docks a market resolving within 12
   * hours, which is exactly the property this ranking is looking for.
   */
  shortHorizon: {
    weights: ShortHorizonWeights;
    /**
     * Floor on the days-of-capital denominator.
     *
     * Return per day is `return / days`, which without a floor diverges as the horizon shrinks — a
     * 3% edge resolving in two hours computes to 36% per day and every near-expiry market would
     * pin the top of the list on arithmetic alone. One day is also the honest number: settlement,
     * redemption and manually finding the next bet mean capital does not actually turn over faster
     * than that, so anything quicker is not really earning at the higher rate.
     */
    minCapitalDays: number;
    /** Return per day of capital mapped onto 0-100 across this range. 0%..10% per day. */
    returnPerDayRange: [number, number];
    /** Liquidity mapped onto 0-100 logarithmically between these bounds. */
    liquidityRange: [number, number];
    /**
     * Assumed round-trip execution cost beyond the spread, as a fraction of the price. Covers the
     * fact that the quoted best ask is for an unknown size and the true fill can be worse.
     */
    slippageAllowance: number;
    /** Below this price the payout ratio is tail-dominated; treated as a longshot. */
    longshotPrice: number;
    longshotPenalty: number;
    /** Applied when the edge does not survive crossing the spread. */
    negativeNetEdgePenalty: number;
    /** Applied when there is no resolution date, so return per day cannot be computed at all. */
    unknownHorizonPenalty: number;
    /** Applied when liquidity is too thin to fill even a small stake at the quoted ask. */
    thinBookUsd: number;
    thinBookPenalty: number;
    /** A side needs at least this many qualified traders before it is ranked here. */
    minQualifiedTraders: number;
    insufficientSamplePenalty: number;
  };

  /**
   * SPORTS-SPECIFIC thresholds. See `scoring/sports.ts` for why sports needs its own treatment
   * rather than being just another category filter.
   */
  sports: {
    /**
     * Hours before kickoff inside which money is treated as "late".
     *
     * Sports markets are the one place where WHEN a position was opened carries information
     * independent of who opened it. Lineups, injuries and weather land in the final day, and the
     * closing line is the most accurate price a sports market ever shows. A position taken a week
     * out was taken without most of the information that ends up mattering.
     */
    lateMoneyWindowHours: number;
    /** Price move, in probability points, below which the line is treated as unchanged. */
    flatLineThresholdPoints: number;
    /** Hours to kickoff below which a game counts as imminent. */
    imminentHours: number;
    /** Hours to kickoff above which the line is still soft and low-information. */
    earlyHours: number;
  };
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  traderScore: {
    // Sums to 100. Matches the specified breakdown.
    weights: {
      longTerm: 25,
      consistency: 20,
      recentForm: 15,
      categorySkill: 15,
      riskAdjusted: 10,
      sampleQuality: 10,
      conviction: 5,
    },
    minSampleForFullCredit: 50,
    smallSampleThreshold: 10,
    smallSamplePenalty: 12,
    roiScoreRange: [-0.5, 1.5],
    concentrationThreshold: 0.4,
    concentrationPenalty: 6,
    highPriceShareThreshold: 0.6,
    highPricePenalty: 10,
    redemptionBiasPenalty: 20,
    shortHoldSecondsThreshold: 900, // 15 minutes
    shortHoldPenalty: 8,
    oneWinDominanceThreshold: 0.6,
    oneWinDominancePenalty: 8,
    poorRecentRoiThreshold: -0.1,
    poorRecentFormPenalty: 6,
    marketMakerPenalty: 10,
    botPenalty: 8,
    categoryPriorWeight: 8,
  },

  behavior: {
    highFrequency7d: 300,
    veryHighFrequency7d: 1000,
    scalperMedianHoldSeconds: 1800, // 30 minutes
    lowHeldToResolutionPct: 0.2,
    marketMakerBothSidesCount: 8,
    smallTradeUsd: 25,
    smallTradeShareThreshold: 0.6,
    highTurnoverRatio: 5,
  },

  consensus: {
    weights: {
      agreement: 28,
      traderQuality: 24,
      categorySkill: 14,
      recency: 14,
      convictionRelative: 10,
      entryAlignment: 10,
    },
    qualifiedTraderScore: 60,
    agreementSaturation: 6,
    stalePositionHours: 24 * 21,
    stalePenalty: 10,
    oneWalletShareThreshold: 0.6,
    oneWalletPenalty: 12,
    largeEntryGap: 0.15,
    largeEntryGapPenalty: 12,
    lowLiquidityUsd: 5000,
    lowLiquidityPenalty: 8,
    wideSpread: 0.05,
    wideSpreadPenalty: 6,
    botPenalty: 10,
    recentActivityHours: 24,
  },

  opportunity: {
    // Sums to 100. Matches the specified breakdown.
    weights: {
      consensus: 30,
      traderQuality: 20,
      entryQuality: 15,
      liquidity: 10,
      execution: 10,
      recency: 10,
      clarity: 5,
    },
    liquidityRange: [1_000, 500_000],
    spreadRange: [0.001, 0.08],
    minLiquidityUsd: 2_000,
    lowLiquidityPenalty: 10,
    maxAcceptableSpread: 0.05,
    wideSpreadPenalty: 8,
    staleSignalHours: 24 * 14,
    staleSignalPenalty: 8,
    entryGapPenaltyStart: 0.05,
    entryGapPenaltyPerDollar: 80,
    maxEntryGapPenalty: 20,
    oneWalletShareThreshold: 0.6,
    oneWalletPenalty: 10,
    ambiguousResolutionPenalty: 6,
    shortTimeRemainingHours: 12,
    shortTimeRemainingPenalty: 6,
    minQualifiedTraders: 2,
    insufficientSamplePenalty: 10,
    noQualifiedTraderPenalty: 30,
  },

  eligibility: {
    minQualifiedTradersToList: 1,
    // 2c/98c. Below 2c the payout ratio is so extreme that rounding dominates, and the spread is
    // usually a large fraction of the price; above 98c there is almost no profit left to capture.
    minListedPrice: 0.02,
    maxListedPrice: 0.98,
  },

  entryGap: {
    goodThreshold: 0.05,
    fairThreshold: 0.1,
    poorThreshold: 0.2,
  },

  modelEstimate: {
    maxShiftFraction: 0.5,
    maxShiftAbsolute: 0.12,
    baseUncertainty: 0.04,
    uncertaintyPerMissingTrader: 0.012,
    minUncertainty: 0.02,
    maxUncertainty: 0.15,
  },

  risk: {
    longshotPrice: 0.15,
    thinLiquidityUsd: 10_000,
    imminentResolutionHours: 24,
  },

  shortHorizon: {
    // Sums to 100.
    weights: {
      capitalEfficiency: 40,
      downsideTested: 20,
      signalConfidence: 20,
      executability: 12,
      settlementCertainty: 8,
    },
    minCapitalDays: 1,
    // A sustained 10% per day would be extraordinary. Anything computing above it is far more
    // likely to be a modelling artifact than a real edge, so the scale saturates there rather
    // than letting outliers dominate the ranking.
    returnPerDayRange: [0, 0.1],
    liquidityRange: [500, 100_000],
    slippageAllowance: 0.01,
    longshotPrice: 0.1,
    longshotPenalty: 12,
    negativeNetEdgePenalty: 35,
    unknownHorizonPenalty: 25,
    thinBookUsd: 1_000,
    thinBookPenalty: 15,
    minQualifiedTraders: 2,
    insufficientSamplePenalty: 15,
  },

  sports: {
    lateMoneyWindowHours: 24,
    // Below half a cent the "move" is tick noise on a book quoted in half-cent increments.
    flatLineThresholdPoints: 0.5,
    imminentHours: 6,
    earlyHours: 24 * 7,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type ScoringOverrides = DeepPartial<ScoringConfig>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue;
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

/** Merges database overrides over the file defaults. Invalid JSON falls back to defaults. */
export function resolveScoringConfig(overrides?: unknown): ScoringConfig {
  if (!overrides) return DEFAULT_SCORING_CONFIG;
  try {
    return deepMerge(DEFAULT_SCORING_CONFIG, overrides);
  } catch {
    return DEFAULT_SCORING_CONFIG;
  }
}

/** Entry-price buckets. A trader who only buys 98¢ favourites should not look like a genius. */
export const ENTRY_PRICE_BUCKETS = [
  { key: "0-10", label: "0–10¢", min: 0, max: 0.1 },
  { key: "10-25", label: "10–25¢", min: 0.1, max: 0.25 },
  { key: "25-40", label: "25–40¢", min: 0.25, max: 0.4 },
  { key: "40-60", label: "40–60¢", min: 0.4, max: 0.6 },
  { key: "60-75", label: "60–75¢", min: 0.6, max: 0.75 },
  { key: "75-90", label: "75–90¢", min: 0.75, max: 0.9 },
  { key: "90-100", label: "90–100¢", min: 0.9, max: 1.0001 },
] as const;

export type EntryBucketKey = (typeof ENTRY_PRICE_BUCKETS)[number]["key"];

export function entryBucketFor(price: number | null | undefined): EntryBucketKey | null {
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  if (price < 0 || price > 1) return null;
  for (const bucket of ENTRY_PRICE_BUCKETS) {
    if (price >= bucket.min && price < bucket.max) return bucket.key;
  }
  return null;
}

/** Human-readable labels for every score component, used by the UI breakdown panels. */
export const COMPONENT_LABELS: Record<string, string> = {
  longTerm: "Long-term performance",
  consistency: "Consistency",
  recentForm: "Recent form",
  categorySkill: "Category skill",
  riskAdjusted: "Risk-adjusted return",
  sampleQuality: "Sample quality",
  conviction: "Conviction",
  agreement: "Independent agreement",
  traderQuality: "Trader quality",
  recency: "Recent activity",
  convictionRelative: "Relative conviction",
  entryAlignment: "Entry alignment",
  consensus: "Smart money consensus",
  entryQuality: "Entry quality",
  liquidity: "Liquidity",
  execution: "Execution quality",
  clarity: "Resolution clarity",
};
