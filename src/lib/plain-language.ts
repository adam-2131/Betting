/**
 * Plain-English rendering of an opportunity.
 *
 * The rest of the interface is written for someone who already knows what an entry gap or a
 * consensus score is. This module says the same thing in ordinary words, so a card can be
 * understood without first learning the vocabulary.
 *
 * Two rules it follows, both from the product brief:
 *
 *   1. Everything here is DESCRIPTIVE, never predictive. It says what tracked traders did and what
 *      a stake would buy. It never says an outcome is likely, and it never suggests an amount to
 *      stake — `$7 would buy 17 shares` is a fact about arithmetic, `you should put in $7` is
 *      advice, and only the first is allowed.
 *   2. Missing data produces a shorter sentence, never a fabricated one. Any figure that could not
 *      be obtained is simply left out of the prose rather than rendered as zero.
 *
 * All pure and unit-tested, because these sentences are the part of the product most likely to be
 * read literally and acted on.
 */
import { formatCents, formatUsd, safeNumber } from "@/lib/num";
import { calculatePayout } from "@/lib/scoring/payout";

export type EntryVerdict =
  | "SIMILAR_ENTRY"
  | "PAYING_MORE"
  | "LATE"
  | "BETTER_THAN_THEM"
  | "UNKNOWN";

export interface PlainSummaryInput {
  outcomeLabel: string;
  currentPrice: number | null;
  trackedEntry: number | null;
  entryGap: number | null;
  qualifiedTraders: number;
  opposingTraders: number;
  bankroll?: number;
}

export interface PlainSummary {
  /** One line: who is on this side, and at what price. */
  headline: string;
  /** How your entry compares with theirs. Empty when there is no tracked entry to compare to. */
  entry: string;
  /** What a stake buys. Empty when no bankroll is configured or the price is unusable. */
  stake: string;
  /** The concrete action, always manual. */
  action: string;
  verdict: EntryVerdict;
  verdictLabel: string;
}

const VERDICT_LABELS: Record<EntryVerdict, string> = {
  BETTER_THAN_THEM: "Cheaper than they paid",
  SIMILAR_ENTRY: "About what they paid",
  PAYING_MORE: "You'd pay more",
  LATE: "Move already happened",
  UNKNOWN: "No entry price to compare",
};

/**
 * Thresholds in cents. These match the bands the `EntryGap` component already colours, so the
 * words and the colour never disagree.
 */
export function entryVerdict(entryGapCents: number | null): EntryVerdict {
  if (entryGapCents === null || !Number.isFinite(entryGapCents)) return "UNKNOWN";
  if (entryGapCents < -1) return "BETTER_THAN_THEM";
  if (entryGapCents <= 3) return "SIMILAR_ENTRY";
  if (entryGapCents <= 8) return "PAYING_MORE";
  return "LATE";
}

export function describeOpportunity(input: PlainSummaryInput): PlainSummary {
  const price = safeNumber(input.currentPrice);
  const trackedEntry = safeNumber(input.trackedEntry);
  const gap = safeNumber(input.entryGap);
  const gapCents = gap === null ? null : gap * 100;
  const verdict = entryVerdict(gapCents);

  const side = input.outcomeLabel.trim() || "this outcome";
  const traders = input.qualifiedTraders;

  // --- Headline ------------------------------------------------------------
  const who =
    traders <= 0
      ? "No qualified tracked trader currently holds this side"
      : traders === 1
        ? "1 tracked trader is holding"
        : `${traders} tracked traders are holding`;

  let headline =
    traders <= 0
      ? who
      : `${who} ${side.toUpperCase()}${price === null ? "" : `, now priced at ${formatCents(price)}`}`;

  if (input.opposingTraders > 0) {
    headline += ` — though ${input.opposingTraders} tracked ${
      input.opposingTraders === 1 ? "trader is" : "traders are"
    } on the other side`;
  }
  headline += ".";

  // --- Entry comparison ----------------------------------------------------
  let entry = "";
  if (trackedEntry !== null && gapCents !== null) {
    const magnitude = Math.abs(gapCents);
    const rounded = magnitude < 1 ? magnitude.toFixed(1) : Math.round(magnitude).toString();

    switch (verdict) {
      case "BETTER_THAN_THEM":
        entry = `They bought at about ${formatCents(trackedEntry)}. It is ${rounded}¢ cheaper now, so you would be getting in below their price.`;
        break;
      case "SIMILAR_ENTRY":
        entry = `They bought at about ${formatCents(trackedEntry)}, so you would be paying roughly what they did.`;
        break;
      case "PAYING_MORE":
        entry = `They bought at about ${formatCents(trackedEntry)}. You would be paying ${rounded}¢ more, which is a worse deal than they got.`;
        break;
      case "LATE":
        entry = `They bought at about ${formatCents(trackedEntry)}. You would be paying ${rounded}¢ more — most of the move they positioned for has already happened, so this is a different trade from the one they made.`;
        break;
      default:
        entry = "";
    }
  } else if (traders > 0) {
    entry = "There is no recorded entry price for these traders, so there is no way to tell whether the move has already happened.";
  }

  // --- Stake illustration --------------------------------------------------
  let stake = "";
  if (input.bankroll !== undefined && price !== null) {
    const result = calculatePayout(input.bankroll, price);
    if (!result.invalid && result.shares !== null && result.grossPayout !== null) {
      const profit =
        result.grossPayout !== null ? result.grossPayout - result.stake : null;
      stake = `${formatUsd(result.stake)} would buy ${result.shares.toFixed(1)} shares. If ${side.toUpperCase()} wins you get ${formatUsd(result.grossPayout)}${
        profit === null ? "" : ` (a ${formatUsd(profit)} profit)`
      }. If it loses you get nothing back.`;
    }
  }

  // --- Action --------------------------------------------------------------
  const action =
    traders <= 0
      ? "Nothing to follow here."
      : `To follow this you would buy ${side.toUpperCase()} yourself on Polymarket. PolyAlpha never places, sizes or signs a trade.`;

  return {
    headline,
    entry,
    stake,
    action,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
  };
}

/**
 * The honest one-line answer to "so should I buy this?".
 *
 * Kept in one place because it is the sentence most likely to be quoted back, and because the
 * backtest result it reflects is a real finding rather than boilerplate caution.
 */
export const WHAT_THIS_CANNOT_TELL_YOU =
  "This ranking has not been shown to predict winners. Backtesting found no reliable relationship between a high score and a good outcome, so treat a high score as a place to start looking, not as a reason to buy.";
