/**
 * CLOSING LINE VALUE.
 *
 * The question this product cannot otherwise answer is "is any of this working". Win rate answers
 * it far too slowly: at a dollar a bet, separating a genuine 55% edge from a lucky run of coin
 * flips takes hundreds of settled positions, and this project's own backtest is a demonstration of
 * how long a flattering number can survive before someone checks it properly.
 *
 * CLV answers it sooner, and it is the measure sports bettors have used for decades for exactly
 * this reason. A market's price just before it closes is the most accurate figure it ever
 * produces — it is the point at which the most information has been incorporated by the most
 * participants. Buying below that price means you were ahead of the market; buying above it means
 * you were behind. That is true of a bet that lost and false of a bet that won, which is precisely
 * what makes it useful: it measures the decision rather than the outcome.
 *
 * The reason it converges faster is that every bet yields a continuous number instead of a
 * Bernoulli one. A win/loss carries a fraction of a bit; "you bought 3.2 points below the close"
 * carries far more, so the mean stabilises in tens of bets rather than hundreds.
 *
 * WHAT IT IS NOT. Positive CLV is not profit and does not become profit on its own — costs still
 * have to be cleared, and a market can close wrong. It is evidence that the process is finding
 * real prices, which is a necessary condition for making money and not a sufficient one.
 *
 * Pure and synchronous.
 */
import { mean, safeNumber, stdDev } from "@/lib/num";

export interface ClvSample {
  /** Price paid per share. */
  entryPrice: number;
  /** Market price for the same outcome at or just before the close. */
  closingPrice: number;
}

/**
 * Points of value captured, from the buyer's side.
 *
 * A back is only ever a buy here — PolyAlpha has no shorting — so a HIGHER closing price is
 * favourable: the market ended up rating the outcome more likely than you paid for.
 */
export function clvPoints(entryPrice: number | null, closingPrice: number | null): number | null {
  const entry = safeNumber(entryPrice);
  const close = safeNumber(closingPrice);
  if (entry === null || close === null) return null;
  if (entry <= 0 || entry >= 1 || close < 0 || close > 1) return null;
  return (close - entry) * 100;
}

export type ClvVerdict =
  /** The interval excludes zero on the positive side. */
  | "BEATING_THE_CLOSE"
  /** The interval excludes zero on the negative side. */
  | "PAYING_UP"
  /** The interval straddles zero. More bets needed. */
  | "INCONCLUSIVE"
  /** Fewer than the minimum needed to say anything at all. */
  | "TOO_FEW";

/**
 * Below this, no statistic is reported at all.
 *
 * Not a significance threshold — it is the point below which a mean and a standard deviation are
 * not descriptions of anything. Reporting "average CLV +4.1 points" from two bets invites exactly
 * the over-reading this whole module exists to prevent.
 */
export const MIN_SAMPLE = 5;

/** Normal approximation. Fine at these sample sizes and stated as an approximation in the UI. */
const Z_95 = 1.96;

export interface ClvSummary {
  count: number;
  /** Mean CLV in points. Null below MIN_SAMPLE. */
  meanPoints: number | null;
  /** Sample standard deviation in points. */
  stdDevPoints: number | null;
  /** Standard error of the mean. */
  standardError: number | null;
  /** 95% confidence interval on the mean, in points. */
  intervalLow: number | null;
  intervalHigh: number | null;
  /** Share of bets bought below the close, 0..1. */
  positiveRate: number | null;
  verdict: ClvVerdict;
  /**
   * Bets needed in total before the current mean would clear zero, if it holds.
   *
   * Null when the mean is zero or the spread is unknown. This is a projection from the observed
   * numbers, not a promise — and it is deliberately shown, because "how much longer until I know"
   * is the question a small sample actually raises.
   */
  betsNeeded: number | null;
}

export function summarizeClv(samples: ClvSample[]): ClvSummary {
  const points = samples
    .map((s) => clvPoints(s.entryPrice, s.closingPrice))
    .filter((p): p is number => p !== null);

  const count = points.length;

  if (count < MIN_SAMPLE) {
    return {
      count,
      meanPoints: null,
      stdDevPoints: null,
      standardError: null,
      intervalLow: null,
      intervalHigh: null,
      // Reported even below the sample floor: it needs no variance estimate and it is the one
      // figure a handful of bets can honestly support.
      positiveRate: count > 0 ? points.filter((p) => p > 0).length / count : null,
      verdict: "TOO_FEW",
      betsNeeded: null,
    };
  }

  const meanPoints = mean(points);
  const sd = stdDev(points);
  const standardError = sd === null ? null : sd / Math.sqrt(count);

  const intervalLow =
    meanPoints === null || standardError === null ? null : meanPoints - Z_95 * standardError;
  const intervalHigh =
    meanPoints === null || standardError === null ? null : meanPoints + Z_95 * standardError;

  let verdict: ClvVerdict = "INCONCLUSIVE";
  if (intervalLow !== null && intervalLow > 0) verdict = "BEATING_THE_CLOSE";
  else if (intervalHigh !== null && intervalHigh < 0) verdict = "PAYING_UP";

  return {
    count,
    meanPoints,
    stdDevPoints: sd,
    standardError,
    intervalLow,
    intervalHigh,
    positiveRate: points.filter((p) => p > 0).length / count,
    verdict,
    betsNeeded: projectBetsNeeded(meanPoints, sd),
  };
}

/**
 * How many bets it would take for an effect this size to clear zero.
 *
 * Solves n = (z × sd / |mean|)² — the sample at which the interval half-width equals the mean.
 * Capped, because an effect near zero projects to an unbounded number and "10,000 more bets" is
 * not a more useful statement than "far more than you will place".
 */
function projectBetsNeeded(meanPoints: number | null, sd: number | null): number | null {
  if (meanPoints === null || sd === null) return null;
  if (Math.abs(meanPoints) < 1e-9 || sd <= 0) return null;
  const needed = Math.ceil((Z_95 * sd / Math.abs(meanPoints)) ** 2);
  return Number.isFinite(needed) && needed <= 5000 ? needed : null;
}

/** One sentence, always populated, stating what the sample does and does not support. */
export function describeClv(summary: ClvSummary): string {
  const { count, meanPoints, intervalLow, intervalHigh, betsNeeded, verdict } = summary;

  if (verdict === "TOO_FEW") {
    const remaining = MIN_SAMPLE - count;
    return count === 0
      ? "No bet has reached its close yet. Log a few and this will start reporting whether you are getting better prices than the market's final ones."
      : `${count} bet${count === 1 ? "" : "s"} measured. ${remaining} more before an average is worth reporting — below that a mean is not describing anything.`;
  }

  const avg = `${(meanPoints ?? 0) >= 0 ? "+" : ""}${(meanPoints ?? 0).toFixed(2)} points`;
  const range = `${(intervalLow ?? 0).toFixed(2)} to ${(intervalHigh ?? 0).toFixed(2)}`;

  switch (verdict) {
    case "BEATING_THE_CLOSE":
      return `Across ${count} bets you are buying ${avg} below where the market finished, and the 95% range (${range}) stays above zero. That is evidence the selection is finding real prices — it is not profit, since costs still have to be cleared, but it is the necessary half.`;
    case "PAYING_UP":
      return `Across ${count} bets you are buying ${avg} relative to the close, and the 95% range (${range}) stays below zero. You are consistently paying above the market's final price, which no hit rate corrects. This is the signal to stop and change something.`;
    case "INCONCLUSIVE":
      return `Across ${count} bets the average is ${avg}, but the 95% range (${range}) still includes zero, so this is not yet distinguishable from chance.${
        betsNeeded === null
          ? " The effect is too close to zero to project how many more would settle it."
          : ` At this rate and spread it would take about ${betsNeeded} bets in total.`
      }`;
    default:
      return "";
  }
}
