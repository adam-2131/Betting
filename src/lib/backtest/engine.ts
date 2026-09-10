/**
 * BACKTEST ENGINE
 *
 * Question it answers: when the Opportunity Score was high, did the outcome actually win more
 * often than its price implied? Not "would I have made money" — that depends on stake sizing,
 * which this product deliberately never advises.
 *
 * ===========================================================================
 * HOW LOOK-AHEAD BIAS IS PREVENTED
 * ===========================================================================
 *
 * Look-ahead bias is the error of scoring a past moment with information that did not exist yet.
 * It is what makes almost every naive backtest look brilliant. Four separate leaks are possible
 * here, and each is closed structurally rather than by being careful:
 *
 * 1. LEAK: using a trader's CURRENT Smart Trader Score to decide they were "smart" back then.
 *    This is the big one. Today's score for a wallet includes every position that resolved after
 *    the signal — including, often, the very market being tested. A wallet is in our watchlist
 *    precisely BECAUSE it went on to do well, so its present score is contaminated by the future
 *    at every historical date.
 *    CLOSED: `scoreTradersAsOf(T)` recomputes each trader's score from scratch using only
 *    ClosedPosition rows with `resolvedAt < T`, and passes `now: T` so recency windows, monthly
 *    buckets and sample-size credit are all measured as of T. A trader with no resolved history
 *    before T scores from an empty record and is not qualified — correctly, because at T we had
 *    no evidence about them.
 *
 * 2. LEAK: using final position sizes as though they were held from the start.
 *    A trader who scaled into a winner looks, in the end-state data, like a huge early conviction
 *    bet.
 *    CLOSED: positions are rebuilt by replaying `TradeActivity` fills with `occurredAt <= T` and
 *    summing signed shares and cost. Fills after T do not exist to the reconstruction.
 *
 * 3. LEAK: pricing the entry at a price observed later.
 *    CLOSED: the price at T is the last price actually observed at or before T — a MarketSnapshot
 *    captured at or before T, else the most recent tracked fill at or before T. If neither
 *    exists, the market is SKIPPED and counted in `skipped.noPriceAtSignal`. It is never
 *    back-filled from the resolved price or from today's price, and never interpolated between a
 *    before-point and an after-point.
 *
 * 4. LEAK: choosing the evaluation moment with hindsight.
 *    Picking T "when the smart money got in" selects the good entries after the fact.
 *    CLOSED: T is mechanical — `resolvedAt - horizonDays` for every market alike, declared before
 *    the run and stored with it. Markets whose horizon predates their own start date are skipped.
 *
 * Two honest limitations remain, and both are reported in the run output rather than hidden:
 *
 *  - SURVIVORSHIP IN THE WATCHLIST. The wallets are on the list because they rank on a
 *    leaderboard today. Recomputing their scores as of T removes the score contamination but not
 *    the fact that this set of wallets was chosen with knowledge of the present. A backtest can
 *    only tell you whether the score ranked these traders' positions usefully; it cannot tell you
 *    that you would have been tracking these wallets at the time.
 *  - REDEMPTION BIAS in the resolved record (see DATA_MODEL.md §1.5) inflates historical scores
 *    for wallets that only redeem winners, at T just as it does today.
 */
import { Category, type PrismaClient } from "@prisma/client";
import { safeNumber } from "@/lib/num";
import { computeConsensus, type ConsensusHolder } from "@/lib/scoring/consensus";
import { computeOpportunityScore } from "@/lib/scoring/opportunity";
import { computeTraderScore, type ResolvedPosition } from "@/lib/scoring/trader-score";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "@/lib/scoring/config";
import {
  calibrationTest,
  wilsonInterval,
  type CalibrationResult,
  type Interval,
} from "./stats";
import { seriesFromJson } from "@/lib/sync/prices";
import { TESTABLE_MARKET_ORDER, testableMarketWhere } from "./market-selection";
import type { ClobPricePoint } from "@/lib/polymarket/types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface BacktestParams {
  /** Only markets resolving in this window are tested. */
  from: Date;
  to: Date;
  /** Signal time is `resolvedAt - horizonDays`, applied uniformly. */
  horizonDays: number;
  /** Skip markets whose observed price at T is outside this band. */
  minPrice: number;
  maxPrice: number;
  /** Sides with fewer reconstructed holders than this are not scored. */
  minHolders: number;
  /** Cap on markets tested, for runtime. Oldest-first within the window. */
  maxMarkets: number;
  /**
   * Reject a signal whose benchmark price was already this many hours old at T. `null` accepts any
   * age, which is what the earlier runs did implicitly — and it flattered them, because a stale
   * price sits below the true one on markets heading for YES and so inflates the payout on winners.
   */
  maxPriceAgeHours: number | null;
}

export const DEFAULT_BACKTEST_PARAMS: BacktestParams = {
  from: new Date(Date.now() - 180 * DAY_MS),
  to: new Date(),
  horizonDays: 7,
  minPrice: 0.05,
  maxPrice: 0.95,
  minHolders: 1,
  maxMarkets: 600,
  maxPriceAgeHours: 24,
};

export interface BacktestSignalRow {
  marketId: string;
  question: string;
  category: Category;
  outcomeIndex: number;
  outcomeLabel: string;
  signalAt: Date;
  priceAtSignal: number;
  priceSource: PriceSource;
  /**
   * How old the benchmark price was at the signal moment. A large value means the "market implied
   * probability" this signal is scored against is really a quote from some earlier state of the
   * market, which biases the measured edge and payout.
   */
  priceAgeHours: number;
  opportunityScore: number;
  consensusScore: number;
  qualifiedTraders: number;
  holders: number;
  weightedEntry: number | null;
  entryGap: number | null;
  won: boolean;
  resolvedAt: Date;
  /** Profit on a hypothetical $1 stake: +((1/p)−1) if it won, −1 if it lost. */
  pnlPerDollar: number;
}

export interface ScoreBucket {
  label: string;
  min: number;
  max: number;
  signals: number;
  wins: number;
  /** Observed win rate. */
  winRate: number | null;
  /** 95% Wilson interval on the win rate. A point estimate alone overstates what n signals know. */
  winRateInterval: Interval | null;
  /**
   * Mean price at signal — the market's own implied probability, and the benchmark the score has
   * to beat. A bucket that wins 80% of the time at an average price of 82¢ found nothing.
   */
  impliedWinRate: number | null;
  /** Observed minus implied, in percentage points. Positive = the score added information. */
  edgePoints: number | null;
  roi: number | null;
}

export interface BacktestResults {
  signals: number;
  wins: number;
  losses: number;
  winRate: number | null;
  winRateInterval: Interval | null;
  impliedWinRate: number | null;
  edgePoints: number | null;
  /**
   * Whether any of this is distinguishable from chance, tested against the market's own prices.
   * Without it the buckets below are just six point estimates competing to look impressive.
   */
  calibration: CalibrationResult | null;
  roi: number | null;
  maxDrawdown: number | null;
  buckets: ScoreBucket[];
  /**
   * Rank correlation between opportunity score and outcome (Spearman on score vs won).
   * The single most informative number here: near 0 means the score did not rank anything.
   */
  rankCorrelation: number | null;
  marketsConsidered: number;
  marketsTested: number;
  skipped: {
    noResolvedOutcome: number;
    horizonBeforeStart: number;
    signalNotYetPast: number;
    noPriceAtSignal: number;
    priceOutOfBand: number;
    priceTooStale: number;
    noHoldersAtSignal: number;
  };
  tradersScored: number;
  warnings: string[];
  /** How the benchmark prices were sourced, and how close to the signal they were. */
  priceQuality: {
    bySource: Record<PriceSource, number>;
    medianAgeHours: number | null;
    p90AgeHours: number | null;
  };
}

const BUCKET_EDGES: Array<[number, number, string]> = [
  [0, 20, "0–20"],
  [20, 40, "20–40"],
  [40, 55, "40–55"],
  [55, 70, "55–70"],
  [70, 85, "70–85"],
  [85, 100.01, "85–100"],
];

// ---------------------------------------------------------------------------
// Point-in-time trader scoring
// ---------------------------------------------------------------------------

interface DatedClosedPosition extends ResolvedPosition {
  traderId: string;
}

/**
 * Each tracked trader's Smart Trader Score using only what had resolved before `asOf`.
 *
 * Leak #1 is closed here. Note that `open` is deliberately empty: open-position value is a
 * present-day observation with no historical equivalent, and it never counted toward the track
 * record anyway. Behavior classification is also passed as null rather than reusing today's
 * classification, since that too was derived from the full activity history.
 */
export function scoreTradersAsOf(
  closedByTrader: Map<string, DatedClosedPosition[]>,
  asOf: Date,
  config: ScoringConfig,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [traderId, positions] of closedByTrader) {
    const known = positions.filter((p) => p.resolvedAt !== null && p.resolvedAt < asOf);
    if (known.length === 0) {
      scores.set(traderId, 0);
      continue;
    }
    const result = computeTraderScore(
      { resolved: known, open: [], portfolioValue: null, behavior: null, now: asOf },
      config,
    );
    scores.set(traderId, result.score);
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Point-in-time position reconstruction
// ---------------------------------------------------------------------------

interface Fill {
  traderId: string;
  occurredAt: Date;
  asset: string;
  outcomeIndex: number;
  side: "BUY" | "SELL";
  shares: number;
  usd: number;
  price: number | null;
}

interface ReconstructedPosition {
  traderId: string;
  outcomeIndex: number;
  shares: number;
  costUsd: number;
  avgPrice: number | null;
  firstBuyAt: Date | null;
  /** Net USD bought in the 24h before T — the recent-accumulation input. */
  recentNetUsd: number;
}

/**
 * Replays fills up to `asOf` into holdings. Leak #2 is closed here: the loop simply never sees a
 * fill dated after `asOf`.
 *
 * Sells reduce shares and cost basis proportionally, so `avgPrice` stays the average price of what
 * is still held rather than of everything ever bought.
 */
export function reconstructPositions(fills: Fill[], asOf: Date): ReconstructedPosition[] {
  const recentCutoff = new Date(asOf.getTime() - 24 * HOUR_MS);
  const byKey = new Map<string, ReconstructedPosition>();

  const ordered = fills
    .filter((f) => f.occurredAt <= asOf)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  for (const fill of ordered) {
    const key = `${fill.traderId}:${fill.outcomeIndex}`;
    const state =
      byKey.get(key) ??
      ({
        traderId: fill.traderId,
        outcomeIndex: fill.outcomeIndex,
        shares: 0,
        costUsd: 0,
        avgPrice: null,
        firstBuyAt: null,
        recentNetUsd: 0,
      } satisfies ReconstructedPosition);

    if (fill.side === "BUY") {
      state.shares += fill.shares;
      state.costUsd += fill.usd;
      state.firstBuyAt ??= fill.occurredAt;
      if (fill.occurredAt >= recentCutoff) state.recentNetUsd += fill.usd;
    } else {
      // Reduce cost basis in proportion to the shares leaving, so the remaining average holds.
      const fraction = state.shares > 0 ? Math.min(1, fill.shares / state.shares) : 1;
      state.costUsd = Math.max(0, state.costUsd * (1 - fraction));
      state.shares = Math.max(0, state.shares - fill.shares);
      if (fill.occurredAt >= recentCutoff) state.recentNetUsd -= fill.usd;
    }

    state.avgPrice = state.shares > 0 ? state.costUsd / state.shares : null;
    byKey.set(key, state);
  }

  // A dust remainder is an artefact of partial fills, not a position.
  return [...byKey.values()].filter((p) => p.shares > 0.5 && p.costUsd > 0.5);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Spearman rank correlation. Ties get averaged ranks. */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rank = (values: number[]): number[] => {
    const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
      i = j + 1;
    }
    return ranks;
  };

  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const meanR = (n + 1) / 2;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - meanR;
    const b = ry[i] - meanR;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  const r = num / Math.sqrt(dx * dy);
  return Number.isFinite(r) ? r : null;
}

function bucketize(signals: BacktestSignalRow[]): ScoreBucket[] {
  return BUCKET_EDGES.map(([min, max, label]) => {
    const inBucket = signals.filter((s) => s.opportunityScore >= min && s.opportunityScore < max);
    const wins = inBucket.filter((s) => s.won).length;
    const impliedWinRate =
      inBucket.length > 0
        ? inBucket.reduce((acc, s) => acc + s.priceAtSignal, 0) / inBucket.length
        : null;
    const winRate = inBucket.length > 0 ? wins / inBucket.length : null;
    const roi =
      inBucket.length > 0
        ? inBucket.reduce((acc, s) => acc + s.pnlPerDollar, 0) / inBucket.length
        : null;
    return {
      label,
      min,
      max,
      signals: inBucket.length,
      wins,
      winRate,
      winRateInterval: wilsonInterval(wins, inBucket.length),
      impliedWinRate,
      edgePoints:
        winRate !== null && impliedWinRate !== null ? (winRate - impliedWinRate) * 100 : null,
      roi,
    };
  });
}

/** Worst peak-to-trough of the equal-stake cumulative PnL, in dollars per $1 staked per signal. */
function maxDrawdown(signals: BacktestSignalRow[]): number | null {
  if (signals.length === 0) return null;
  const ordered = [...signals].sort((a, b) => a.resolvedAt.getTime() - b.resolvedAt.getTime());
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const signal of ordered) {
    cumulative += signal.pnlPerDollar;
    peak = Math.max(peak, cumulative);
    worst = Math.min(worst, cumulative - peak);
  }
  return worst;
}

export function summarize(
  signals: BacktestSignalRow[],
  counters: BacktestResults["skipped"],
  marketsConsidered: number,
  marketsTested: number,
  tradersScored: number,
): BacktestResults {
  const wins = signals.filter((s) => s.won).length;
  const losses = signals.length - wins;
  const winRate = signals.length > 0 ? wins / signals.length : null;
  const impliedWinRate =
    signals.length > 0
      ? signals.reduce((acc, s) => acc + s.priceAtSignal, 0) / signals.length
      : null;
  const roi =
    signals.length > 0
      ? signals.reduce((acc, s) => acc + s.pnlPerDollar, 0) / signals.length
      : null;

  const buckets = bucketize(signals);
  const rankCorrelation = spearman(
    signals.map((s) => s.opportunityScore),
    signals.map((s) => (s.won ? 1 : 0)),
  );

  const bucketIndexOf = (score: number) =>
    BUCKET_EDGES.findIndex(([min, max]) => score >= min && score < max);

  const calibration =
    signals.length > 0
      ? calibrationTest(
          signals.map((s) => ({
            bucket: bucketIndexOf(s.opportunityScore),
            impliedProbability: s.priceAtSignal,
            score: s.opportunityScore,
            won: s.won,
          })),
          BUCKET_EDGES.length,
        )
      : null;

  const ages = signals.map((s) => s.priceAgeHours).sort((a, b) => a - b);
  const quantile = (q: number): number | null =>
    ages.length === 0 ? null : ages[Math.min(ages.length - 1, Math.floor(ages.length * q))];
  const priceQuality: BacktestResults["priceQuality"] = {
    bySource: signals.reduce(
      (acc, s) => {
        acc[s.priceSource]++;
        return acc;
      },
      { series: 0, snapshot: 0, trade: 0 } as Record<PriceSource, number>,
    ),
    medianAgeHours: quantile(0.5),
    p90AgeHours: quantile(0.9),
  };

  const warnings: string[] = [];
  if (signals.length < 30) {
    warnings.push(
      `Only ${signals.length} historical signals were reconstructed. Nothing at this sample size separates skill from noise; treat every number below as indicative at best.`,
    );
  }

  // The significance test is the only thing here that can distinguish a real edge from a lucky
  // bucket, so its verdict is stated before any of the point estimates are discussed.
  if (calibration?.bestBucketEdgePValue !== null && calibration?.bestBucketEdgePValue !== undefined) {
    const p = calibration.bestBucketEdgePValue;
    const best = calibration.bestBucketIndex;
    const label = best !== null ? BUCKET_EDGES[best]?.[2] : null;
    if (p > 0.05) {
      warnings.push(
        `The best-performing score band${label ? ` (${label})` : ""} beat its own prices by ${calibration.bestBucketEdgePoints?.toFixed(1)}pp, but simulating these same signals against the market's prices produces a band that good ${(p * 100).toFixed(0)}% of the time by chance alone (p=${p.toFixed(3)}, ${calibration.iterations} iterations). That is not evidence of an edge.`,
      );
    } else {
      warnings.push(
        `The best-performing score band${label ? ` (${label})` : ""} beat its own prices by ${calibration.bestBucketEdgePoints?.toFixed(1)}pp, which chance reproduced in only ${(p * 100).toFixed(1)}% of ${calibration.iterations} simulations (p=${p.toFixed(3)}). This survives the multiple-band comparison, but it is one test on one dataset — it is a reason to keep measuring, not a demonstrated edge.`,
      );
    }
  }

  // The headline edge can be positive while the score itself is ranking nothing — or ranking
  // backwards. That is the single most important thing a backtest can tell you about a score, and
  // it is easy to miss next to a positive-looking aggregate, so it is stated outright.
  if (rankCorrelation !== null && rankCorrelation <= 0.02) {
    warnings.push(
      `Higher opportunity scores did not lead to better outcomes in this run (rank correlation ${rankCorrelation.toFixed(3)}). Whatever aggregate edge appears above, the score did not order these signals usefully, so a high score should not be read as a stronger signal than a middling one.`,
    );
  }

  const populated = buckets.filter((b) => b.signals >= 20 && b.edgePoints !== null);
  if (populated.length >= 2) {
    const worst = populated[populated.length - 1];
    const best = populated[0];
    if ((worst.edgePoints as number) < (best.edgePoints as number)) {
      warnings.push(
        `The highest-scoring bucket with a usable sample (${worst.label}, n=${worst.signals}) did worse against its own prices than the lowest (${best.label}, n=${best.signals}). The relationship between score and outcome is not monotonic here.`,
      );
    }
  }
  // Stale benchmark prices are not a coverage problem, they are a validity problem: the price is
  // both what the win rate is compared against and the denominator of the payout, and staleness
  // biases it downward on markets heading for YES. That inflates results in the flattering
  // direction, so it is called out rather than left in the skip table.
  if (priceQuality.medianAgeHours !== null && priceQuality.medianAgeHours > 6) {
    warnings.push(
      `Half the benchmark prices were already more than ${priceQuality.medianAgeHours.toFixed(1)} hours old at the signal moment (90th percentile ${priceQuality.p90AgeHours?.toFixed(1)}h). Prices drift toward the eventual outcome, so an old price sits too low on markets that went on to win — which inflates both the measured edge and the payout. Run \`npm run sync -- --only=prices\` to backfill real CLOB price curves before trusting these numbers.`,
    );
  }
  if (priceQuality.bySource.trade > priceQuality.bySource.series + priceQuality.bySource.snapshot) {
    warnings.push(
      `Most benchmark prices (${priceQuality.bySource.trade} of ${signals.length}) came from the last tracked fill rather than a market quote. A fill is a real execution, but it is only observed when a tracked wallet happened to trade, so it can be arbitrarily far from the signal moment.`,
    );
  }
  if (counters.noPriceAtSignal > marketsTested) {
    warnings.push(
      `${counters.noPriceAtSignal} markets were skipped because no price was observed at or before the signal time. Price history only exists for the period this installation has been syncing, so older windows will be sparse.`,
    );
  }
  warnings.push(
    "The tracked wallets were selected using present-day leaderboards. Their scores here are recomputed point-in-time, but the choice of which wallets to follow at all is still made with hindsight, so a positive result overstates what was achievable.",
  );

  return {
    signals: signals.length,
    wins,
    losses,
    winRate,
    winRateInterval: wilsonInterval(wins, signals.length),
    impliedWinRate,
    edgePoints:
      winRate !== null && impliedWinRate !== null ? (winRate - impliedWinRate) * 100 : null,
    calibration,
    roi,
    maxDrawdown: maxDrawdown(signals),
    buckets,
    rankCorrelation,
    priceQuality,
    marketsConsidered,
    marketsTested,
    skipped: counters,
    tradersScored,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface BacktestOutput {
  params: BacktestParams;
  results: BacktestResults;
  signals: BacktestSignalRow[];
}

export async function runBacktest(
  prisma: PrismaClient,
  params: BacktestParams = DEFAULT_BACKTEST_PARAMS,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): Promise<BacktestOutput> {
  const horizonMs = params.horizonDays * DAY_MS;

  // Shared with the price backfill so the two cannot select different markets — see
  // `market-selection.ts` for the bug that made this necessary.
  const markets = await prisma.market.findMany({
    where: testableMarketWhere({ from: params.from, to: params.to }),
    orderBy: TESTABLE_MARKET_ORDER,
    take: params.maxMarkets,
    select: {
      id: true,
      conditionId: true,
      question: true,
      category: true,
      outcomes: true,
      resolvedOutcomeIndex: true,
      resolvedAt: true,
      endDate: true,
      startDate: true,
      liquidity: true,
      spread: true,
      volume24hr: true,
      clarityScore: true,
      clarityFlags: true,
    },
  });

  const marketIds = markets.map((m) => m.id);

  // Every tracked trader's settled record, for point-in-time rescoring.
  const closedRows =
    marketIds.length > 0
      ? await prisma.closedPosition.findMany({
          select: {
            traderId: true,
            conditionId: true,
            category: true,
            avgPrice: true,
            costBasisUsd: true,
            realizedPnl: true,
            won: true,
            resolvedAt: true,
            endDate: true,
          },
        })
      : [];

  const closedByTrader = new Map<string, DatedClosedPosition[]>();
  for (const row of closedRows) {
    const resolvedAt = row.resolvedAt ?? row.endDate;
    if (!resolvedAt) continue;
    const list = closedByTrader.get(row.traderId) ?? [];
    list.push({
      traderId: row.traderId,
      conditionId: row.conditionId,
      category: row.category,
      avgPrice: row.avgPrice,
      costBasisUsd: row.costBasisUsd,
      realizedPnl: row.realizedPnl,
      won: row.won,
      resolvedAt,
    });
    closedByTrader.set(row.traderId, list);
  }

  const traders = await prisma.trader.findMany({
    select: { id: true, wallet: true, displayName: true },
  });
  const traderById = new Map(traders.map((t) => [t.id, t]));

  const [fills, snapshots] = await Promise.all([
    marketIds.length > 0
      ? prisma.tradeActivity.findMany({
          where: { marketId: { in: marketIds }, type: "TRADE" },
          select: {
            marketId: true,
            traderId: true,
            occurredAt: true,
            asset: true,
            outcomeIndex: true,
            side: true,
            size: true,
            usdcSize: true,
            price: true,
          },
          orderBy: { occurredAt: "asc" },
        })
      : [],
    marketIds.length > 0
      ? prisma.marketSnapshot.findMany({
          where: { marketId: { in: marketIds } },
          select: {
            marketId: true,
            capturedAt: true,
            prices: true,
            spread: true,
            liquidity: true,
            volume24hr: true,
          },
          orderBy: { capturedAt: "asc" },
        })
      : [],
  ]);

  const fillsByMarket = new Map<string, Fill[]>();
  for (const row of fills) {
    if (!row.marketId || !row.asset || row.outcomeIndex === null || !row.side) continue;
    const shares = safeNumber(row.size);
    const usd = safeNumber(row.usdcSize);
    if (shares === null || shares <= 0 || usd === null || usd <= 0) continue;
    const list = fillsByMarket.get(row.marketId) ?? [];
    list.push({
      traderId: row.traderId,
      occurredAt: row.occurredAt,
      asset: row.asset,
      outcomeIndex: row.outcomeIndex,
      side: row.side,
      shares,
      usd,
      price: safeNumber(row.price),
    });
    fillsByMarket.set(row.marketId, list);
  }

  const snapshotsByMarket = new Map<string, typeof snapshots>();
  for (const snapshot of snapshots) {
    const list = snapshotsByMarket.get(snapshot.marketId) ?? [];
    list.push(snapshot);
    snapshotsByMarket.set(snapshot.marketId, list);
  }

  // Backfilled CLOB curves, the preferred price source. Absent until `npm run sync -- --only=prices`
  // has run, in which case the older snapshot/fill path still applies.
  const seriesByMarket = new Map<string, PriceSeries[]>();
  for (let i = 0; i < marketIds.length; i += 500) {
    const rows = await prisma.marketPriceSeries.findMany({
      where: { marketId: { in: marketIds.slice(i, i + 500) } },
      select: { marketId: true, outcomeIndex: true, points: true },
    });
    for (const row of rows) {
      const points = seriesFromJson(row.points);
      if (points.length === 0) continue;
      const list = seriesByMarket.get(row.marketId) ?? [];
      list.push({ outcomeIndex: row.outcomeIndex, points });
      seriesByMarket.set(row.marketId, list);
    }
  }

  const counters: BacktestResults["skipped"] = {
    noResolvedOutcome: 0,
    horizonBeforeStart: 0,
    signalNotYetPast: 0,
    noPriceAtSignal: 0,
    priceOutOfBand: 0,
    priceTooStale: 0,
    noHoldersAtSignal: 0,
  };
  const evaluatedAt = new Date();

  // Trader scores are expensive and change slowly, so they are computed once per UTC day rather
  // than once per market. The cache key is the day containing T, and every score in it is still
  // built only from positions resolved before that day — no future information enters.
  const scoreCache = new Map<string, Map<string, number>>();
  const scoresAsOf = (asOf: Date): Map<string, number> => {
    const key = asOf.toISOString().slice(0, 10);
    const cached = scoreCache.get(key);
    if (cached) return cached;
    const dayStart = new Date(`${key}T00:00:00.000Z`);
    const computed = scoreTradersAsOf(closedByTrader, dayStart, config);
    scoreCache.set(key, computed);
    return computed;
  };

  const signals: BacktestSignalRow[] = [];
  let marketsTested = 0;

  for (const market of markets) {
    const resolvedAt = market.resolvedAt;
    const winningIndex = market.resolvedOutcomeIndex;
    if (!resolvedAt || winningIndex === null) {
      counters.noResolvedOutcome++;
      continue;
    }

    const signalAt = new Date(resolvedAt.getTime() - horizonMs);
    if (market.startDate && signalAt < market.startDate) {
      counters.horizonBeforeStart++;
      continue;
    }
    // A resolution timestamp is only ever an upper bound (see sync/markets resolutionTimestamp),
    // so a horizon shorter than the overstatement can land in the future. There is nothing to
    // evaluate at a moment that has not happened.
    if (signalAt >= evaluatedAt) {
      counters.signalNotYetPast++;
      continue;
    }

    const marketFills = fillsByMarket.get(market.id) ?? [];
    const holdings = reconstructPositions(marketFills, signalAt);
    if (holdings.length === 0) {
      counters.noHoldersAtSignal++;
      continue;
    }

    const observed = priceAtSignal(
      seriesByMarket.get(market.id) ?? [],
      snapshotsByMarket.get(market.id) ?? [],
      marketFills,
      signalAt,
      market.outcomes.length,
    );
    if (!observed) {
      counters.noPriceAtSignal++;
      continue;
    }

    const priceAgeHours = Math.max(
      0,
      (signalAt.getTime() - observed.observedAt.getTime()) / 3_600_000,
    );
    if (params.maxPriceAgeHours !== null && priceAgeHours > params.maxPriceAgeHours) {
      counters.priceTooStale++;
      continue;
    }

    const scores = scoresAsOf(signalAt);
    const bySide = new Map<number, ReconstructedPosition[]>();
    for (const holding of holdings) {
      const list = bySide.get(holding.outcomeIndex) ?? [];
      list.push(holding);
      bySide.set(holding.outcomeIndex, list);
    }

    let testedThisMarket = false;

    for (const [outcomeIndex, sideHoldings] of bySide) {
      if (sideHoldings.length < params.minHolders) continue;

      const price = observed.prices[outcomeIndex];
      if (price === undefined || !Number.isFinite(price) || price <= 0 || price >= 1) {
        counters.noPriceAtSignal++;
        continue;
      }
      if (price < params.minPrice || price > params.maxPrice) {
        counters.priceOutOfBand++;
        continue;
      }

      const toHolder = (holding: ReconstructedPosition): ConsensusHolder | null => {
        const trader = traderById.get(holding.traderId);
        if (!trader) return null;
        // Value the reconstructed position at the price observed at T, not at settlement.
        return {
          traderId: holding.traderId,
          wallet: trader.wallet,
          displayName: trader.displayName,
          smartScore: scores.get(holding.traderId) ?? 0,
          // Category skill as of T is folded into the score; a separate historical per-category
          // series would need its own point-in-time pass and is not attempted here.
          categorySkill: null,
          sizeUsd: holding.shares * price,
          avgPrice: holding.avgPrice,
          openedAt: holding.firstBuyAt,
          typicalPositionUsd: null,
          recentNetUsd: holding.recentNetUsd,
          likelyBot: false,
        };
      };

      const holders = sideHoldings
        .map(toHolder)
        .filter((h): h is ConsensusHolder => h !== null);
      if (holders.length === 0) continue;

      const opposing = [...bySide.entries()]
        .filter(([index]) => index !== outcomeIndex)
        .flatMap(([, list]) => list)
        .map(toHolder)
        .filter((h): h is ConsensusHolder => h !== null);

      const consensus = computeConsensus(
        holders,
        opposing,
        {
          category: market.category,
          currentPrice: price,
          liquidity: observed.liquidity,
          spread: observed.spread,
          now: signalAt,
        },
        config,
      );

      const hoursSinceLastActivity = (() => {
        const recent = marketFills
          .filter((f) => f.occurredAt <= signalAt && f.outcomeIndex === outcomeIndex)
          .at(-1);
        return recent ? (signalAt.getTime() - recent.occurredAt.getTime()) / HOUR_MS : null;
      })();

      const opportunity = computeOpportunityScore(
        {
          conditionId: market.conditionId,
          question: market.question,
          category: market.category,
          outcomeIndex,
          outcomeLabel: market.outcomes[outcomeIndex] ?? `Outcome ${outcomeIndex}`,
          currentPrice: price,
          liquidity: observed.liquidity,
          spread: observed.spread,
          volume24hr: observed.volume24hr,
          // The end date was known at T, so using it is not look-ahead.
          endDate: market.endDate,
          clarityScore: market.clarityScore,
          clarityFlags: market.clarityFlags,
          hasBotContributors: false,
          hoursSinceLastActivity,
        },
        consensus,
        signalAt,
        config,
      );

      const won = outcomeIndex === winningIndex;
      const pnlPerDollar = won ? 1 / price - 1 : -1;
      if (!Number.isFinite(pnlPerDollar)) continue;

      signals.push({
        marketId: market.id,
        question: market.question,
        category: market.category,
        outcomeIndex,
        outcomeLabel: market.outcomes[outcomeIndex] ?? `Outcome ${outcomeIndex}`,
        signalAt,
        priceAtSignal: price,
        priceSource: observed.source,
        priceAgeHours,
        opportunityScore: opportunity.score,
        consensusScore: consensus.score,
        qualifiedTraders: consensus.qualifiedTraderCount,
        holders: consensus.traderCount,
        weightedEntry: consensus.weightedEntryPrice,
        entryGap: consensus.entryGap,
        won,
        resolvedAt,
        pnlPerDollar,
      });
      testedThisMarket = true;
    }

    if (testedThisMarket) marketsTested++;
  }

  return {
    params,
    results: summarize(signals, counters, markets.length, marketsTested, closedByTrader.size),
    signals,
  };
}

export type PriceSource = "series" | "snapshot" | "trade";

export interface PriceSeries {
  outcomeIndex: number;
  points: ClobPricePoint[];
}

/** Last sample at or before `ts`. Binary search — the series are sorted ascending by `t`. */
export function lastSampleAtOrBefore(
  points: ClobPricePoint[],
  ts: number,
): ClobPricePoint | null {
  let low = 0;
  let high = points.length - 1;
  let result: ClobPricePoint | null = null;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (points[mid].t <= ts) {
      result = points[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

/** In a binary market a known price on one side implies the other. */
function inferBinaryComplement(prices: number[]): void {
  if (prices.length !== 2) return;
  if (Number.isNaN(prices[0]) && !Number.isNaN(prices[1])) prices[0] = 1 - prices[1];
  if (Number.isNaN(prices[1]) && !Number.isNaN(prices[0])) prices[1] = 1 - prices[0];
}

interface ObservedPrice {
  prices: number[];
  liquidity: number | null;
  spread: number | null;
  volume24hr: number | null;
  source: PriceSource;
  /** When the quote was actually observed. Never after `asOf`. */
  observedAt: Date;
}

/**
 * The last price genuinely observable at or before `asOf`. Leak #3 is closed here.
 *
 * Preference order:
 *   1. A backfilled CLOB price curve (`MarketPriceSeries`) — hourly samples across the whole life
 *      of the market, so the quote is almost always within an hour of `asOf`.
 *   2. A stored `MarketSnapshot` — a real quote, but only for periods this installation was running.
 *   3. The most recent tracked fill — a real execution, but possibly weeks old.
 *
 * The ordering is by *recency guarantee*, not by data quality: all three are real observed prices,
 * but only the first reliably sits close to `asOf`. That matters because this price is the
 * benchmark the win rate is measured against and the denominator of the payout, so a stale value
 * biases the result in the flattering direction (see src/lib/sync/prices.ts).
 *
 * Nothing is interpolated across `asOf`, and nothing is derived from the settlement.
 */
function priceAtSignal(
  series: PriceSeries[],
  snapshots: Array<{
    capturedAt: Date;
    prices: number[];
    spread: number | null;
    liquidity: number | null;
    volume24hr: number | null;
  }>,
  fills: Fill[],
  asOf: Date,
  outcomeCount: number,
): ObservedPrice | null {
  const asOfTs = Math.floor(asOf.getTime() / 1000);

  if (series.length > 0) {
    const prices = new Array<number>(Math.max(outcomeCount, 2)).fill(Number.NaN);
    let newest = 0;
    let found = false;

    for (const entry of series) {
      const sample = lastSampleAtOrBefore(entry.points, asOfTs);
      if (!sample) continue;
      if (entry.outcomeIndex >= prices.length) continue;
      if (sample.p <= 0 || sample.p >= 1) continue;
      prices[entry.outcomeIndex] = sample.p;
      newest = Math.max(newest, sample.t);
      found = true;
    }

    if (found) {
      inferBinaryComplement(prices);
      return {
        prices,
        liquidity: null,
        spread: null,
        volume24hr: null,
        source: "series",
        observedAt: new Date(newest * 1000),
      };
    }
  }

  const priorSnapshots = snapshots.filter((s) => s.capturedAt <= asOf);
  const latest = priorSnapshots.at(-1);
  if (latest && latest.prices.some((p) => Number.isFinite(p) && p > 0 && p < 1)) {
    return {
      prices: latest.prices,
      liquidity: latest.liquidity,
      spread: latest.spread,
      volume24hr: latest.volume24hr,
      source: "snapshot",
      observedAt: latest.capturedAt,
    };
  }

  // Fall back to the last observed execution on each side.
  const prices = new Array<number>(Math.max(outcomeCount, 2)).fill(Number.NaN);
  let found = false;
  let observedAt = new Date(0);
  for (const fill of fills) {
    if (fill.occurredAt > asOf) break;
    const price = fill.price;
    if (price === null || !Number.isFinite(price) || price <= 0 || price >= 1) continue;
    // A SELL of outcome i executes at outcome i's price too, so side does not matter here.
    prices[fill.outcomeIndex] = price;
    if (fill.occurredAt > observedAt) observedAt = fill.occurredAt;
    found = true;
  }
  if (!found) return null;

  inferBinaryComplement(prices);

  return {
    prices,
    liquidity: null,
    spread: null,
    volume24hr: null,
    source: "trade",
    observedAt,
  };
}
