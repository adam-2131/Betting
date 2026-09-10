/**
 * Entry-gap analysis — the load-bearing idea of the whole product.
 *
 *   entryGap = currentPrice − weightedSmartMoneyEntryPrice
 *
 * A brilliant trader who bought YES at 21¢ tells you very little when the price is 68¢, because
 * buying now is a materially different trade: worse odds, less upside, and the thesis may already
 * have played out. A positive gap means you would be paying more than the smart money did.
 *
 * Pure and synchronous.
 */
import { safeNumber, weightedMean } from "@/lib/num";
import type { ScoringConfig } from "./config";
import { DEFAULT_SCORING_CONFIG } from "./config";

export type EntryQuality = "GOOD" | "FAIR" | "POOR" | "STALE" | "BETTER_THAN_ELITE" | "UNKNOWN";

export interface EntryGapResult {
  currentPrice: number | null;
  weightedEntryPrice: number | null;
  /** currentPrice − weightedEntryPrice, in dollars (so 0.03 = +3¢). */
  entryGap: number | null;
  /** entryGap as a fraction of the entry price. */
  entryGapPct: number | null;
  quality: EntryQuality;
  label: string;
  /** 0-100, feeds the Opportunity Score's entry-quality component. */
  score: number | null;
  explanation: string;
}

export interface EntryContribution {
  avgPrice: number | null | undefined;
  /** Weight = position size in USD × trader quality. Non-positive weights are ignored. */
  weight: number | null | undefined;
}

/** Quality-weighted average entry price across the traders on one side of a market. */
export function weightedEntryPrice(contributions: EntryContribution[]): number | null {
  return weightedMean(
    contributions.map((c) => ({ value: c.avgPrice, weight: c.weight })),
  );
}

const QUALITY_LABELS: Record<EntryQuality, string> = {
  BETTER_THAN_ELITE: "Better than elite entry",
  GOOD: "Good",
  FAIR: "Acceptable",
  POOR: "Poor entry",
  STALE: "Poor entry / signal may be stale",
  UNKNOWN: "Unavailable",
};

export function analyzeEntryGap(
  currentPriceInput: unknown,
  weightedEntryInput: unknown,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): EntryGapResult {
  const currentPrice = safeNumber(currentPriceInput);
  const weightedEntry = safeNumber(weightedEntryInput);

  if (currentPrice === null || weightedEntry === null || weightedEntry <= 0) {
    return {
      currentPrice,
      weightedEntryPrice: weightedEntry,
      entryGap: null,
      entryGapPct: null,
      quality: "UNKNOWN",
      label: QUALITY_LABELS.UNKNOWN,
      score: null,
      explanation:
        "No tracked-trader entry price is available for this market, so today's price cannot be compared to smart-money entries.",
    };
  }

  const entryGap = currentPrice - weightedEntry;
  const entryGapPct = entryGap / weightedEntry;
  const magnitude = Math.abs(entryGap);
  const { goodThreshold, fairThreshold, poorThreshold } = config.entryGap;

  let quality: EntryQuality;
  if (entryGap < -goodThreshold) {
    // Cheaper than the smart money paid. Not automatically good — it can mean the thesis broke —
    // but the entry itself is not the problem.
    quality = "BETTER_THAN_ELITE";
  } else if (magnitude <= goodThreshold) {
    quality = "GOOD";
  } else if (magnitude <= fairThreshold) {
    quality = "FAIR";
  } else if (magnitude <= poorThreshold) {
    quality = "POOR";
  } else {
    quality = "STALE";
  }

  // Score: full credit at zero gap, decaying as the price runs away from smart money.
  // Entering cheaper is credited, but capped below a perfectly aligned entry because a large
  // negative gap usually means something went wrong with the original thesis.
  let score: number;
  if (entryGap <= 0) {
    score = Math.min(100, 90 + Math.min(10, (magnitude / poorThreshold) * 10));
    if (magnitude > poorThreshold) score = 75;
  } else {
    score = Math.max(0, 100 - (entryGap / poorThreshold) * 85);
  }

  return {
    currentPrice,
    weightedEntryPrice: weightedEntry,
    entryGap,
    entryGapPct,
    quality,
    label: QUALITY_LABELS[quality],
    score: Math.round(score * 10) / 10,
    explanation: explainEntryGap(quality, currentPrice, weightedEntry, entryGap),
  };
}

function cents(value: number): string {
  return `${(value * 100).toFixed(0)}¢`;
}

function explainEntryGap(
  quality: EntryQuality,
  currentPrice: number,
  weightedEntry: number,
  entryGap: number,
): string {
  const gapText = `${entryGap >= 0 ? "+" : "−"}${Math.abs(entryGap * 100).toFixed(1)}¢`;
  const prices = `Tracked traders entered around ${cents(weightedEntry)}; the market is ${cents(currentPrice)} (${gapText}).`;

  switch (quality) {
    case "BETTER_THAN_ELITE":
      return `${prices} You would be entering cheaper than the tracked traders did. That is not automatically an advantage — the price may have fallen because the thesis weakened.`;
    case "GOOD":
      return `${prices} Today's entry is close to what the smart money paid, so you would be taking a similar trade.`;
    case "FAIR":
      return `${prices} Today's entry is somewhat worse than the smart money's, which reduces the remaining upside.`;
    case "POOR":
      return `${prices} Much of the move the tracked traders were positioned for has already happened. Buying now is a materially different trade with less room to run.`;
    case "STALE":
      return `${prices} The price has moved so far past the tracked entries that this signal is likely stale. The traders' edge was captured at a much lower price.`;
    default:
      return prices;
  }
}

/** Compact badge text for tables. */
export function entryGapBadge(result: EntryGapResult): { text: string; tone: "good" | "warn" | "bad" | "neutral" } {
  switch (result.quality) {
    case "GOOD":
      return { text: "Entry aligned", tone: "good" };
    case "BETTER_THAN_ELITE":
      return { text: "Below elite entry", tone: "neutral" };
    case "FAIR":
      return { text: "Entry acceptable", tone: "neutral" };
    case "POOR":
      return { text: "Chasing", tone: "warn" };
    case "STALE":
      return { text: "Likely stale", tone: "bad" };
    default:
      return { text: "Unavailable", tone: "neutral" };
  }
}
