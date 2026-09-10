/**
 * Statistical honesty for the backtest.
 *
 * Without this, the backtest reports "+13.6pp edge on 144 signals" as though it were a fact. It is
 * a point estimate from a small sample, chosen as the best of six buckets, and both of those
 * inflate it. This module answers two questions the raw numbers cannot:
 *
 *   1. How wide is the uncertainty on a win rate?  -> `wilsonInterval`
 *   2. Could an edge this large have arisen by chance if the score carried no information?
 *      -> `calibrationTest`
 *
 * All pure and synchronous. The RNG is seeded so a run is reproducible and testable.
 */

export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Preferred over the textbook normal approximation because it does not run off the end of [0,1]
 * and stays sensible at small n and extreme rates — which is exactly where this backtest lives
 * (a bucket of 8 signals at a 37.5% win rate breaks the normal approximation outright).
 */
export function wilsonInterval(successes: number, n: number, z = 1.959964): Interval | null {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n <= 0) return null;
  if (successes < 0 || successes > n) return null;

  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const halfWidth =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;

  const low = Math.max(0, centre - halfWidth);
  const high = Math.min(1, centre + halfWidth);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low, high };
}

/** mulberry32 — small, fast, and deterministic from a seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CalibrationObservation {
  /** Bucket index this observation falls in, or -1 to exclude it from bucket statistics. */
  bucket: number;
  /** The market's own implied probability at the signal time. */
  impliedProbability: number;
  /** Score used for the rank-correlation statistic. */
  score: number;
  won: boolean;
}

export interface CalibrationResult {
  iterations: number;
  /**
   * Probability of seeing a bucket edge at least as extreme as the observed best, purely by
   * chance, if the market price were the true probability of every outcome.
   *
   * This is a max-statistic test, so looking at six buckets is already paid for — no separate
   * multiple-comparison correction is needed or valid on top of it.
   */
  bestBucketEdgePValue: number | null;
  /** The observed statistic the p-value refers to, in percentage points. */
  bestBucketEdgePoints: number | null;
  bestBucketIndex: number | null;
  /** Probability of a rank correlation at least as positive as observed, under the same null. */
  rankCorrelationPValue: number | null;
  /** Aggregate edge across all observations, and the chance of it under the null. */
  overallEdgePoints: number | null;
  overallEdgePValue: number | null;
  /** Buckets below this are ignored when picking the best, since 3 signals prove nothing. */
  minBucketSize: number;
}

function rankCorrelation(scores: number[], outcomes: number[]): number | null {
  const n = scores.length;
  if (n < 3) return null;

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

  const rx = rank(scores);
  const ry = rank(outcomes);
  const meanRank = (n + 1) / 2;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - meanRank;
    const b = ry[i] - meanRank;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  const r = num / Math.sqrt(dx * dy);
  return Number.isFinite(r) ? r : null;
}

/**
 * Per-bucket edge in percentage points: observed win rate minus mean implied probability.
 * Returns null for buckets below `minBucketSize`.
 */
function bucketEdges(
  observations: CalibrationObservation[],
  outcomes: number[],
  bucketCount: number,
  minBucketSize: number,
): Array<number | null> {
  const wins = new Array<number>(bucketCount).fill(0);
  const counts = new Array<number>(bucketCount).fill(0);
  const impliedSum = new Array<number>(bucketCount).fill(0);

  for (let i = 0; i < observations.length; i++) {
    const bucket = observations[i].bucket;
    if (bucket < 0 || bucket >= bucketCount) continue;
    counts[bucket]++;
    impliedSum[bucket] += observations[i].impliedProbability;
    wins[bucket] += outcomes[i];
  }

  return counts.map((count, b) => {
    if (count < minBucketSize) return null;
    return (wins[b] / count - impliedSum[b] / count) * 100;
  });
}

/**
 * Parametric bootstrap under the market's own model.
 *
 * The null hypothesis is the one that actually matters: *the score adds nothing beyond the price*.
 * So each iteration re-draws every outcome as Bernoulli(price at signal) and recomputes the
 * statistics. Note this is NOT a naive label shuffle — permuting outcomes freely would destroy the
 * true relationship between price and outcome, and would then "prove" an edge for any bucket that
 * happened to contain cheap longshots.
 *
 * Under this null the market is perfectly calibrated by construction, so any apparent edge in the
 * simulated data is pure sampling noise. Comparing the real statistic against that distribution is
 * a direct answer to "would I have seen this anyway?".
 */
export function calibrationTest(
  observations: CalibrationObservation[],
  bucketCount: number,
  options: { iterations?: number; minBucketSize?: number; seed?: number } = {},
): CalibrationResult {
  const iterations = options.iterations ?? 2000;
  const minBucketSize = options.minBucketSize ?? 20;
  const random = seededRandom(options.seed ?? 20260910);

  const empty: CalibrationResult = {
    iterations: 0,
    bestBucketEdgePValue: null,
    bestBucketEdgePoints: null,
    bestBucketIndex: null,
    rankCorrelationPValue: null,
    overallEdgePoints: null,
    overallEdgePValue: null,
    minBucketSize,
  };

  const usable = observations.filter(
    (o) =>
      Number.isFinite(o.impliedProbability) &&
      o.impliedProbability > 0 &&
      o.impliedProbability < 1 &&
      Number.isFinite(o.score),
  );
  if (usable.length < 10) return empty;

  const scores = usable.map((o) => o.score);
  const observedOutcomes: number[] = usable.map((o) => (o.won ? 1 : 0));

  // --- Observed statistics -------------------------------------------------
  const observedEdges = bucketEdges(usable, observedOutcomes, bucketCount, minBucketSize);
  let bestBucketIndex: number | null = null;
  let bestBucketEdgePoints: number | null = null;
  for (let b = 0; b < bucketCount; b++) {
    const edge = observedEdges[b];
    if (edge === null) continue;
    if (bestBucketEdgePoints === null || edge > bestBucketEdgePoints) {
      bestBucketEdgePoints = edge;
      bestBucketIndex = b;
    }
  }

  const observedRank = rankCorrelation(scores, observedOutcomes);

  const meanImplied =
    usable.reduce((acc, o) => acc + o.impliedProbability, 0) / usable.length;
  const observedWinRate = observedOutcomes.reduce((a, b) => a + b, 0) / usable.length;
  const overallEdgePoints = (observedWinRate - meanImplied) * 100;

  // --- Null distribution ---------------------------------------------------
  let bucketAtLeastAsExtreme = 0;
  let rankAtLeastAsExtreme = 0;
  let overallAtLeastAsExtreme = 0;
  const simulated = new Array<number>(usable.length);

  for (let iteration = 0; iteration < iterations; iteration++) {
    let simulatedWins = 0;
    for (let i = 0; i < usable.length; i++) {
      const won = random() < usable[i].impliedProbability ? 1 : 0;
      simulated[i] = won;
      simulatedWins += won;
    }

    if (bestBucketEdgePoints !== null) {
      const edges = bucketEdges(usable, simulated, bucketCount, minBucketSize);
      let best = Number.NEGATIVE_INFINITY;
      for (const edge of edges) {
        if (edge !== null && edge > best) best = edge;
      }
      if (best >= bestBucketEdgePoints) bucketAtLeastAsExtreme++;
    }

    if (observedRank !== null) {
      const r = rankCorrelation(scores, simulated);
      if (r !== null && r >= observedRank) rankAtLeastAsExtreme++;
    }

    const simulatedEdge = (simulatedWins / usable.length - meanImplied) * 100;
    if (simulatedEdge >= overallEdgePoints) overallAtLeastAsExtreme++;
  }

  // +1 in numerator and denominator: with 2000 iterations the smallest reportable p-value is
  // 1/2001, never 0. Claiming p = 0 from a finite simulation would be an overstatement.
  const pValue = (count: number) => (count + 1) / (iterations + 1);

  return {
    iterations,
    bestBucketEdgePValue: bestBucketEdgePoints === null ? null : pValue(bucketAtLeastAsExtreme),
    bestBucketEdgePoints,
    bestBucketIndex,
    rankCorrelationPValue: observedRank === null ? null : pValue(rankAtLeastAsExtreme),
    overallEdgePoints,
    overallEdgePValue: pValue(overallAtLeastAsExtreme),
    minBucketSize,
  };
}

/** Plain-language reading of a p-value. Deliberately conservative wording. */
export function significanceLabel(pValue: number | null): {
  text: string;
  tone: "positive" | "warning" | "neutral";
} {
  if (pValue === null) return { text: "Not testable", tone: "neutral" };
  if (pValue <= 0.01) return { text: "Unlikely to be chance", tone: "positive" };
  if (pValue <= 0.05) return { text: "Possibly real", tone: "positive" };
  if (pValue <= 0.2) return { text: "Consistent with chance", tone: "warning" };
  return { text: "Indistinguishable from chance", tone: "warning" };
}
