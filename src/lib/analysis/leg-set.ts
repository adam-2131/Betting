/**
 * OVERROUND — how much the whole event costs to cover.
 *
 * If a game's outcomes are home, draw and away, then backing all three guarantees exactly $1 back.
 * Their prices should therefore sum to $1. They never quite do, and the excess is the house's cut:
 * on a live Japanese league game the three legs asked 37¢, 30¢ and 35¢, which is $1.02 to be
 * certain of $1.
 *
 * That two cents sits underneath every edge in that game. A signal claiming 1.5 points of edge on
 * one of those legs is not claiming an edge at all — it is inside the vig. Nothing else in the
 * product notices this, because every other check looks at one market side in isolation and the
 * overround only exists across the set.
 *
 * THE HARD PART IS KNOWING WHICH MARKETS FORM A SET. Summing the wrong markets produces a
 * confident, meaningless number. A live Counter-Strike event held eleven markets — map handicaps,
 * map winners, round totals, series totals — whose outcome-0 prices summed to 4.97. Those are not
 * alternatives to each other, they are different questions about the same match, and treating them
 * as a leg set would have reported 397% of vig.
 *
 * So a set is only recognised where mutual exclusivity can be established rather than guessed:
 *
 *   1. `negRisk` events. Polymarket's negative-risk flag means exactly this — the legs are
 *      mutually exclusive and exhaustive, and it enforces it. A live 24-driver F1 championship
 *      market summed to 0.965.
 *   2. Soccer-style moneyline events where EVERY market is a moneyline, every one is a Yes/No, and
 *      there are two or three of them. That is the home/draw/away shape and nothing else has it.
 *
 * Anything else returns null. A missing check is recoverable; a fabricated one is not.
 *
 * Pure and synchronous.
 */
import { safeNumber } from "@/lib/num";

export interface LegMarket {
  id: string;
  question: string;
  outcomes: string[];
  /** Index-aligned with `outcomes`. */
  prices: number[];
  bestAsk: number | null;
  spread: number | null;
  sportsMarketType: string | null;
  negRisk: boolean;
}

export type LegSetKind = "NEG_RISK" | "MATCH_RESULT";

export interface OverroundResult {
  kind: LegSetKind;
  legCount: number;
  /**
   * Sum of the legs' mid prices. 1.00 is a fair book; above is the house's cut, below means the
   * set is collectively underpriced.
   */
  midSum: number;
  /** Overround in probability points, i.e. (midSum − 1) × 100. Negative is an underround. */
  midOverroundPoints: number;
  /**
   * Sum of the legs' ask prices — what covering the whole event would actually cost.
   *
   * Null when any leg is too wide to quote meaningfully. On a 24-leg championship market most legs
   * are near-zero and unquoted, and their nominal asks summed to 10.98, which describes the
   * absence of a book rather than the cost of anything.
   */
  askSum: number | null;
  askOverroundPoints: number | null;
  /** Per-leg detail, for display. */
  legs: Array<{ id: string; label: string; mid: number | null; ask: number | null }>;
}

/** Above this, a leg's ask is not a real quote and the ask-sum is not meaningful. */
const MAX_QUOTABLE_SPREAD = 0.1;

function isYesNo(outcomes: string[]): boolean {
  if (outcomes.length !== 2) return false;
  const lower = outcomes.map((o) => o.trim().toLowerCase());
  return lower.includes("yes") && lower.includes("no");
}

/** Index of the "Yes" outcome, since Polymarket does not guarantee it is index 0. */
function yesIndex(outcomes: string[]): number {
  const i = outcomes.findIndex((o) => o.trim().toLowerCase() === "yes");
  return i >= 0 ? i : 0;
}

/**
 * The mutually exclusive set among an event's markets, or null when none can be established.
 *
 * See the module header for why this refuses far more often than it accepts.
 */
export function findLegSet(markets: LegMarket[]): { kind: LegSetKind; legs: LegMarket[] } | null {
  if (markets.length < 2) return null;

  // 1. Negative-risk events are mutually exclusive by construction.
  const negRisk = markets.filter((m) => m.negRisk);
  if (negRisk.length >= 2 && negRisk.length === markets.length) {
    return { kind: "NEG_RISK", legs: negRisk };
  }

  // 2. The home/draw/away shape: every market a Yes/No moneyline, two or three of them.
  const allMoneyline = markets.every((m) => m.sportsMarketType === "moneyline");
  const allYesNo = markets.every((m) => isYesNo(m.outcomes));
  if (allMoneyline && allYesNo && markets.length >= 2 && markets.length <= 3) {
    return { kind: "MATCH_RESULT", legs: markets };
  }

  return null;
}

export function computeOverround(markets: LegMarket[]): OverroundResult | null {
  const set = findLegSet(markets);
  if (!set) return null;

  let midSum = 0;
  let askSum: number | null = 0;
  const legs: OverroundResult["legs"] = [];

  for (const leg of set.legs) {
    const index = yesIndex(leg.outcomes);
    const mid = safeNumber(leg.prices[index]);
    // `bestAsk` describes outcome 0 only, so it is usable only when Yes IS outcome 0.
    const ask = index === 0 ? safeNumber(leg.bestAsk) : null;
    const spread = safeNumber(leg.spread);

    if (mid === null) return null; // an incomplete set cannot be summed honestly
    midSum += mid;

    if (askSum !== null) {
      if (ask === null || spread === null || spread > MAX_QUOTABLE_SPREAD) askSum = null;
      else askSum += ask;
    }

    legs.push({ id: leg.id, label: legLabel(leg), mid, ask });
  }

  return {
    kind: set.kind,
    legCount: set.legs.length,
    midSum,
    midOverroundPoints: (midSum - 1) * 100,
    askSum,
    askOverroundPoints: askSum === null ? null : (askSum - 1) * 100,
    legs,
  };
}

/** "Will Vissel Kōbe win on 2026-09-11?" -> "Vissel Kōbe win on 2026-09-11". */
function legLabel(leg: LegMarket): string {
  return leg.question
    .trim()
    .replace(/\?+$/, "")
    .replace(/^Will\s+/i, "");
}
