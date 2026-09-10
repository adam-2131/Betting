/**
 * ROBUSTNESS SWEEP
 *
 * Why this exists, concretely. A single backtest run reported a +12.8pp edge in the 20–40 score
 * band at p=0.009 — significant, and already corrected for comparing six bands at once. It looked
 * like a finding. Re-running the identical analysis at neighbouring signal horizons gave p-values
 * of 0.010, 0.128, 0.641, 0.126, 0.023 and 0.573.
 *
 * A real effect does not appear at a one-day horizon, vanish at two and three days, and return at
 * seven. What actually happened is that six configurations were searched and the best one was
 * reported — the oldest way there is to manufacture a result.
 *
 * A per-run significance test cannot catch this, because each run only sees itself. So the sweep
 * is part of the product rather than something to remember to do: it runs the same analysis across
 * several horizons and reports whether a finding survives, refusing to call anything an edge that
 * only shows up in one configuration.
 */
import type { PrismaClient } from "@prisma/client";
import type { ScoringConfig } from "@/lib/scoring/config";
import { DEFAULT_SCORING_CONFIG } from "@/lib/scoring/config";
import { DEFAULT_BACKTEST_PARAMS, runBacktest, type BacktestParams } from "./engine";

export const DEFAULT_HORIZONS = [1, 2, 3, 5, 7, 14];

/** A band counts as replicated only if it clears this in more than one horizon. */
export const REPLICATION_ALPHA = 0.05;

export interface HorizonOutcome {
  horizonDays: number;
  signals: number;
  winRate: number | null;
  impliedWinRate: number | null;
  edgePoints: number | null;
  rankCorrelation: number | null;
  bestBandLabel: string | null;
  bestBandEdgePoints: number | null;
  bestBandPValue: number | null;
  overallEdgePValue: number | null;
  /** True when this horizon on its own would have looked like a discovery. */
  significantAlone: boolean;
}

export type RobustnessVerdict =
  | "REPLICATES"
  | "INCONSISTENT"
  | "DOES NOT REPLICATE"
  | "NOTHING FOUND"
  | "TOO LITTLE DATA";

export interface RobustnessReport {
  horizons: HorizonOutcome[];
  /** Horizons with enough signals to say anything at all. */
  usableHorizons: number;
  significantHorizons: number[];
  /**
   * Bands that cleared the threshold in more than one horizon.
   *
   * `clearedIn` / `usable` is the number that matters. Clearing 2 of 5 while failing at the three
   * horizons in between is not replication — see the note on non-independence below.
   */
  replicatedBands: Array<{ label: string; horizons: number[]; clearedIn: number; usable: number }>;
  verdict: RobustnessVerdict;
  /** Plain-language reading, safe to render directly. */
  narrative: string[];
}

const MIN_SIGNALS_PER_HORIZON = 100;

/**
 * Fraction of usable horizons a band must clear to count as replicated.
 *
 * Deliberately a majority rather than "more than once". Two reasons, both learned from this
 * dataset. First, adjacent horizons are NOT independent samples — they replay overlapping markets
 * and largely the same trades — so two hits are worth far less than two independent experiments.
 * Second, the same band tends to be the max-statistic winner at almost every horizon simply
 * because that is where sample size and variance combine to produce the widest swing, so "the same
 * band came up twice" is close to guaranteed and carries little information on its own.
 */
const REPLICATION_FRACTION = 0.6;

export function summarizeRobustness(horizons: HorizonOutcome[]): RobustnessReport {
  const usable = horizons.filter((h) => h.signals >= MIN_SIGNALS_PER_HORIZON);
  const significant = horizons.filter((h) => h.significantAlone);
  const significantHorizons = significant.map((h) => h.horizonDays);

  const byBand = new Map<string, number[]>();
  for (const horizon of significant) {
    if (!horizon.bestBandLabel) continue;
    const list = byBand.get(horizon.bestBandLabel) ?? [];
    list.push(horizon.horizonDays);
    byBand.set(horizon.bestBandLabel, list);
  }
  const replicatedBands = [...byBand.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([label, list]) => ({
      label,
      horizons: list.sort((a, b) => a - b),
      clearedIn: list.length,
      usable: usable.length,
    }));

  const consistentBands = replicatedBands.filter(
    (band) => band.usable > 0 && band.clearedIn / band.usable >= REPLICATION_FRACTION,
  );

  const verdict: RobustnessVerdict = (() => {
    if (usable.length < 2) return "TOO LITTLE DATA";
    if (consistentBands.length > 0) return "REPLICATES";
    if (replicatedBands.length > 0) return "INCONSISTENT";
    if (significant.length > 0) return "DOES NOT REPLICATE";
    return "NOTHING FOUND";
  })();

  const narrative: string[] = [];
  const tested = horizons.length;

  switch (verdict) {
    case "TOO LITTLE DATA":
      narrative.push(
        `Only ${usable.length} of ${tested} horizons produced at least ${MIN_SIGNALS_PER_HORIZON} signals, which is not enough to check whether anything replicates. Sync more history and run this again.`,
      );
      break;

    case "NOTHING FOUND":
      narrative.push(
        `No score band beat its own prices by more than chance would produce, at any of the ${tested} horizons tested. That is a clean negative result: on this data the Opportunity Score does not identify outcomes the market has mispriced.`,
      );
      break;

    case "DOES NOT REPLICATE":
      narrative.push(
        `A band cleared significance at ${significantHorizons.length} of ${tested} horizons (${significantHorizons.map((d) => `${d}d`).join(", ")}), but no single band did so more than once.`,
        `Neighbouring horizons look at almost the same markets, so a genuine effect should persist across them. One appearing and disappearing is what searching several configurations and keeping the best one looks like. This is not evidence of an edge, and reporting the winning configuration on its own would have been misleading.`,
      );
      break;

    case "INCONSISTENT":
      narrative.push(
        `${replicatedBands
          .map(
            (band) =>
              `The ${band.label} band cleared significance at ${band.clearedIn} of ${band.usable} usable horizons (${band.horizons.map((d) => `${d}d`).join(", ")}), and failed at the rest`,
          )
          .join("; ")}.`,
        `That is not replication. Adjacent horizons replay overlapping markets and largely the same trades, so a real effect should show up at the horizons in between rather than skipping them. The same band also tends to win the best-band comparison at almost every horizon regardless, because that is where sample size and variance produce the widest swing — so seeing it twice is close to expected and carries little information.`,
        `Read this as an unresolved lead, not an edge. It would need to hold across a majority of horizons, or ideally on a period and a watchlist that were not used to find it.`,
      );
      break;

    case "REPLICATES":
      narrative.push(
        `${consistentBands
          .map(
            (band) =>
              `The ${band.label} band cleared significance at ${band.clearedIn} of ${band.usable} usable horizons (${band.horizons.map((d) => `${d}d`).join(", ")})`,
          )
          .join("; ")}.`,
        `Holding across most horizons is a considerably stronger result than a single run, since it cannot be produced by picking the best configuration. But these horizons overlap heavily — they are not independent experiments — and this is still one dataset, one watchlist and one period. It is worth continuing to measure, not a settled conclusion.`,
      );
      break;
  }

  const ranked = horizons.filter((h) => h.rankCorrelation !== null);
  if (ranked.length > 0) {
    const positive = ranked.filter((h) => (h.rankCorrelation as number) > 0).length;
    narrative.push(
      positive === 0
        ? `The rank correlation between score and outcome was negative at every one of the ${ranked.length} horizons tested. The score does not order signals from worse to better — if anything it orders them slightly backwards.`
        : `The rank correlation between score and outcome was positive at ${positive} of ${ranked.length} horizons, so the score's ordering is not consistently informative.`,
    );
  }

  return {
    horizons,
    usableHorizons: usable.length,
    significantHorizons,
    replicatedBands,
    verdict,
    narrative,
  };
}

export async function runRobustnessSweep(
  prisma: PrismaClient,
  base: Omit<BacktestParams, "horizonDays"> = DEFAULT_BACKTEST_PARAMS,
  horizonDays: number[] = DEFAULT_HORIZONS,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): Promise<RobustnessReport> {
  const outcomes: HorizonOutcome[] = [];

  for (const horizon of horizonDays) {
    const { results } = await runBacktest(prisma, { ...base, horizonDays: horizon }, config);
    const calibration = results.calibration;
    const bestBandLabel =
      calibration?.bestBucketIndex !== null && calibration?.bestBucketIndex !== undefined
        ? (results.buckets[calibration.bestBucketIndex]?.label ?? null)
        : null;
    const bestBandPValue = calibration?.bestBucketEdgePValue ?? null;

    outcomes.push({
      horizonDays: horizon,
      signals: results.signals,
      winRate: results.winRate,
      impliedWinRate: results.impliedWinRate,
      edgePoints: results.edgePoints,
      rankCorrelation: results.rankCorrelation,
      bestBandLabel,
      bestBandEdgePoints: calibration?.bestBucketEdgePoints ?? null,
      bestBandPValue,
      overallEdgePValue: calibration?.overallEdgePValue ?? null,
      significantAlone:
        bestBandPValue !== null &&
        bestBandPValue <= REPLICATION_ALPHA &&
        results.signals >= MIN_SIGNALS_PER_HORIZON,
    });
  }

  return summarizeRobustness(outcomes);
}
