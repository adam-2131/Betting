/**
 * READING YOUR OWN RECORD, WITHOUT FOOLING YOURSELF.
 *
 * The obvious next step from a bet log is to have the app learn what you are good at and steer you
 * there. That is exactly the thing this module refuses to do, and the reason is documented at
 * length in this repo already.
 *
 * `README.md` describes a backtest that reported a +12.8pp edge at p=0.009 — significant even
 * after correcting for the six score bands it compared. Re-running the identical analysis at
 * neighbouring horizons gave p values of 0.007, 0.130, 0.686, 0.142, 0.017 and 0.565. The effect
 * was the search, not the data. That happened with thousands of signals. Slicing thirty personal
 * bets by category, price band and score band produces slices of two and three, and whichever one
 * comes out best is noise with a label on it. Acting on it would be the same mistake with a
 * hundredth of the sample.
 *
 * So the split here is deliberate:
 *
 *   DESCRIPTIVE slices are shown with their counts and are gated — a slice below the threshold
 *   reports no average at all, rather than an average with a caveat next to it. Caveats get
 *   skimmed; a blank does not. These are for building intuition about your own behaviour, not for
 *   deciding anything.
 *
 *   ONE INFERENTIAL TEST is offered, and it is pre-specified rather than searched: does the
 *   board's score correspond to the prices you actually got? That is the single question the log
 *   exists to answer, it was chosen before any data arrived, and a single test needs no
 *   multiple-comparison correction because there is nothing to correct for.
 *
 * Pure and synchronous.
 */
import { mean, safeNumber, stdDev } from "@/lib/num";

export interface BetRecord {
  entryPrice: number;
  clvPoints: number | null;
  horizonScore: number | null;
  category: string;
  won: boolean | null;
  pnl: number | null;
  stake: number;
}

export interface RecordSlice {
  label: string;
  /** Bets falling in this slice. */
  count: number;
  /** How many of them have a closing price yet. */
  measured: number;
  /** Mean CLV in points. Null when the slice is below the gate. */
  meanClv: number | null;
  /** Settled record within the slice, shown only as a count. */
  wins: number;
  losses: number;
}

/**
 * Measured bets a slice needs before an average is shown.
 *
 * Higher than it looks necessary because there are several slices per view, and the more slices
 * the more likely one of them looks impressive by chance.
 */
export const SLICE_GATE = 8;

function buildSlice(label: string, records: BetRecord[]): RecordSlice {
  const clv = records
    .map((r) => safeNumber(r.clvPoints))
    .filter((p): p is number => p !== null);

  return {
    label,
    count: records.length,
    measured: clv.length,
    meanClv: clv.length >= SLICE_GATE ? mean(clv) : null,
    wins: records.filter((r) => r.won === true).length,
    losses: records.filter((r) => r.won === false).length,
  };
}

const PRICE_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: "Under 20¢", min: 0, max: 0.2 },
  { label: "20–40¢", min: 0.2, max: 0.4 },
  { label: "40–60¢", min: 0.4, max: 0.6 },
  { label: "60–80¢", min: 0.6, max: 0.8 },
  { label: "80¢ and up", min: 0.8, max: 1.0001 },
];

export function sliceByPrice(records: BetRecord[]): RecordSlice[] {
  return PRICE_BANDS.map((band) =>
    buildSlice(
      band.label,
      records.filter((r) => r.entryPrice >= band.min && r.entryPrice < band.max),
    ),
  );
}

const SCORE_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: "Under 40", min: -Infinity, max: 40 },
  { label: "40–60", min: 40, max: 60 },
  { label: "60–80", min: 60, max: 80 },
  { label: "80+", min: 80, max: Infinity },
];

export function sliceByScore(records: BetRecord[]): RecordSlice[] {
  return SCORE_BANDS.map((band) =>
    buildSlice(
      band.label,
      records.filter((r) => {
        const score = safeNumber(r.horizonScore);
        return score !== null && score >= band.min && score < band.max;
      }),
    ),
  );
}

export function sliceByCategory(records: BetRecord[]): RecordSlice[] {
  const byCategory = new Map<string, BetRecord[]>();
  for (const record of records) {
    const list = byCategory.get(record.category);
    if (list) list.push(record);
    else byCategory.set(record.category, [record]);
  }
  return [...byCategory.entries()]
    .map(([label, rows]) => buildSlice(label, rows))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// The one inferential test
// ---------------------------------------------------------------------------

export type RelationVerdict = "TOO_FEW" | "POSITIVE" | "NEGATIVE" | "NO_RELATION";

export interface ScoreClvRelation {
  n: number;
  /** Pearson correlation between the board's score and the CLV actually achieved. */
  correlation: number | null;
  /** 95% interval via Fisher's z transform. */
  low: number | null;
  high: number | null;
  verdict: RelationVerdict;
}

/**
 * Below this the correlation is not worth computing.
 *
 * A Pearson r on a handful of points swings wildly with any single observation, and this is the
 * one number here people would be tempted to act on.
 */
export const RELATION_GATE = 12;

/**
 * Does a higher board score correspond to a better price than the market closed at?
 *
 * The single pre-specified question, chosen before any bets existed. If the answer is yes, the
 * ranking is doing something and following it more closely is justified. If the answer is no, the
 * score is decoration however good the individual bets happened to look.
 */
export function scoreVsClv(records: BetRecord[]): ScoreClvRelation {
  const pairs = records
    .map((r) => ({ score: safeNumber(r.horizonScore), clv: safeNumber(r.clvPoints) }))
    .filter((p): p is { score: number; clv: number } => p.score !== null && p.clv !== null);

  const n = pairs.length;
  if (n < RELATION_GATE) {
    return { n, correlation: null, low: null, high: null, verdict: "TOO_FEW" };
  }

  const scores = pairs.map((p) => p.score);
  const clvs = pairs.map((p) => p.clv);
  const meanScore = mean(scores);
  const meanClv = mean(clvs);
  const sdScore = stdDev(scores);
  const sdClv = stdDev(clvs);

  // No variation in one variable means no correlation is defined — every bet at the same score
  // says nothing about whether score matters.
  if (meanScore === null || meanClv === null || !sdScore || !sdClv) {
    return { n, correlation: null, low: null, high: null, verdict: "TOO_FEW" };
  }

  const covariance =
    pairs.reduce((acc, p) => acc + (p.score - meanScore) * (p.clv - meanClv), 0) / (n - 1);
  const r = covariance / (sdScore * sdClv);

  if (!Number.isFinite(r)) {
    return { n, correlation: null, low: null, high: null, verdict: "TOO_FEW" };
  }

  const clamped = Math.max(-0.9999, Math.min(0.9999, r));
  // Fisher's z: the interval is symmetric in z, not in r, which is why it is not simply r ± k.
  const z = 0.5 * Math.log((1 + clamped) / (1 - clamped));
  const se = 1 / Math.sqrt(n - 3);
  const low = Math.tanh(z - 1.96 * se);
  const high = Math.tanh(z + 1.96 * se);

  const verdict: RelationVerdict = low > 0 ? "POSITIVE" : high < 0 ? "NEGATIVE" : "NO_RELATION";

  return { n, correlation: r, low, high, verdict };
}

export function describeRelation(relation: ScoreClvRelation): string {
  switch (relation.verdict) {
    case "TOO_FEW":
      return `${relation.n} bet${relation.n === 1 ? "" : "s"} with both a score and a closing price. ${Math.max(0, RELATION_GATE - relation.n)} more before this is worth computing — a correlation on a handful of points moves with every new one.`;
    case "POSITIVE":
      return `Across ${relation.n} bets, a higher score corresponds to a better price than the market closed at (r = ${(relation.correlation ?? 0).toFixed(2)}, 95% range ${(relation.low ?? 0).toFixed(2)} to ${(relation.high ?? 0).toFixed(2)}). That is the ranking doing something real, and the case for weighting it more heavily.`;
    case "NEGATIVE":
      return `Across ${relation.n} bets, a higher score corresponds to a WORSE price than the market closed at (r = ${(relation.correlation ?? 0).toFixed(2)}, 95% range ${(relation.low ?? 0).toFixed(2)} to ${(relation.high ?? 0).toFixed(2)}). Following the ranking more closely is making your prices worse, not better.`;
    case "NO_RELATION":
      return `Across ${relation.n} bets there is no detectable relationship between the score and the price you got (r = ${(relation.correlation ?? 0).toFixed(2)}, 95% range ${(relation.low ?? 0).toFixed(2)} to ${(relation.high ?? 0).toFixed(2)}). The range spans zero, so the ranking is not yet shown to be adding anything.`;
  }
}
