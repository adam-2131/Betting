/**
 * ON-DEMAND DEEP DIVE.
 *
 * The bulk sync deliberately skips per-market API calls — there are around nine thousand markets
 * and each extra request per market is another nine thousand requests. That is the right trade for
 * a ranking pass and the wrong one for the single market you are about to put money into, so this
 * runs only when asked, for one market side, and reads everything the sync could not afford.
 *
 * WHAT IT IS FOR. Not finding better bets — rejecting bad ones. Every check here can contradict
 * the board, and the useful outcome is often "do not take this". Three of them fire on things
 * nothing else in the product can see:
 *
 * THE BOARD'S PRICE IS A SNAPSHOT. Markets are synced in bulk every few minutes, and on a live
 * comparison nine of ten quotes had not moved — but the tenth was the match about to kick off, and
 * it had moved three cents. Staleness concentrates in exactly the markets a short-horizon board
 * points you at. Re-reading the book at decision time is the single most valuable thing here.
 *
 * `bestAsk` IS A PRICE WITHOUT A SIZE. It is the cheapest resting order, however small. Walking
 * the ladder shows whether the quote has anything behind it.
 *
 * THE VIG IS INVISIBLE FROM ONE SIDE. Backing every outcome of a game should cost $1. On a live
 * three-way it cost $1.02, and those two points sit under every edge in that game — a signal
 * claiming 1.5 points is inside the house's cut, not beating it.
 *
 * Findings are reported, never applied. The board keeps its ordering; a flag says so loudly on the
 * row and leaves the ranking alone, because a check that silently reorders results is a check
 * nobody can audit.
 */
import { fetchBook } from "@/lib/polymarket/clob";
import { fetchTrades } from "@/lib/polymarket/data";
import { TTL } from "@/lib/polymarket/http";
import { safeNumber } from "@/lib/num";
import { FILL_LADDER_USD, normalizeAsks, simulateFill, type FillResult } from "./book-fill";
import { computeOverround, type LegMarket, type OverroundResult } from "./leg-set";
import { analyzeTape, significantWindow, type TapeFlow } from "./tape-flow";

export type FindingTone = "GOOD" | "NEUTRAL" | "WARNING" | "STOP";

export interface Finding {
  key: string;
  tone: FindingTone;
  headline: string;
  detail: string;
}

export interface DeepDiveInput {
  /** Market side being analysed. */
  outcomeIndex: number;
  outcomeLabel: string;
  /** CLOB token ids, index-aligned with outcomes. */
  clobTokenIds: string[];
  conditionId: string;
  /** The ask the board priced this row at, including its slippage allowance. */
  boardEffectivePrice: number | null;
  /** Central model probability the board's edge was computed from. */
  modelMid: number | null;
  /** Net edge in points the board is currently advertising. */
  boardNetEdgePoints: number | null;
  /** Every open market in the same event, for the overround check. */
  eventMarkets: LegMarket[];
  now: Date;
}

export interface DeepDive {
  checkedAt: string;
  /** Live best ask from the order book, for this outcome's token. */
  liveBestAsk: number | null;
  /** Fill simulation at $1, $10 and $50. */
  fills: FillResult[];
  /** Net edge recomputed against the live $1 fill rather than the stored quote. */
  liveNetEdgePoints: number | null;
  overround: OverroundResult | null;
  tape: TapeFlow | null;
  findings: Finding[];
  /** Findings that should stop a bet rather than merely inform it. */
  stops: Finding[];
  /** Set when part of the dive could not be completed, so absence is not read as absence of risk. */
  errors: string[];
}

/** A live quote this far from the board's is worth interrupting the reader for. */
const STALE_QUOTE_POINTS = 1;
/** Below this many dollars at the best ask, the quote is not a market. */
const THIN_BEST_ASK_USD = 25;

export async function runDeepDive(input: DeepDiveInput): Promise<DeepDive> {
  const findings: Finding[] = [];
  const errors: string[] = [];
  const token = input.clobTokenIds[input.outcomeIndex];

  // --- Live order book -------------------------------------------------------
  let fills: FillResult[] = [];
  let liveBestAsk: number | null = null;

  if (!token) {
    errors.push("This market has no CLOB token id, so its live book cannot be read.");
  } else {
    try {
      const book = await fetchBook(token);
      const asks = normalizeAsks(book?.asks ?? []);
      fills = FILL_LADDER_USD.map((stake) => simulateFill(asks, stake));
      liveBestAsk = fills[0]?.bestAsk ?? null;

      if (asks.length === 0) {
        findings.push({
          key: "no-book",
          tone: "STOP",
          headline: "There is no order book on this side",
          detail:
            "Nothing is resting on the ask, so there is nothing to buy at any price. The quote the board is showing came from a cached snapshot, not from a live book.",
        });
      }
    } catch (error) {
      errors.push(
        `The live order book could not be read (${error instanceof Error ? error.message : "unknown error"}), so the prices below are still the board's snapshot.`,
      );
    }
  }

  const unitFill = fills[0] ?? null;
  const liveUnitPrice = unitFill?.averagePrice ?? null;

  // --- Has the price moved since the board was built? ------------------------
  const boardPrice = safeNumber(input.boardEffectivePrice);
  if (liveUnitPrice !== null && boardPrice !== null) {
    const driftPoints = (liveUnitPrice - boardPrice) * 100;
    if (Math.abs(driftPoints) >= STALE_QUOTE_POINTS) {
      const worse = driftPoints > 0;
      findings.push({
        key: "price-moved",
        tone: worse ? "WARNING" : "GOOD",
        headline: worse
          ? `The price has moved ${driftPoints.toFixed(1)}¢ against you since the board was built`
          : `The price has moved ${Math.abs(driftPoints).toFixed(1)}¢ in your favour since the board was built`,
        detail: `The board priced this at ${(boardPrice * 100).toFixed(1)}¢. The live book fills a $1 order at ${(liveUnitPrice * 100).toFixed(1)}¢. Every figure on the card was computed from the older number.`,
      });
    }
  }

  // --- Does the edge survive at the live price? ------------------------------
  const modelMid = safeNumber(input.modelMid);
  const liveNetEdgePoints =
    modelMid !== null && liveUnitPrice !== null ? (modelMid - liveUnitPrice) * 100 : null;

  if (liveNetEdgePoints !== null) {
    const boardEdge = safeNumber(input.boardNetEdgePoints);
    if (liveNetEdgePoints <= 0) {
      findings.push({
        key: "edge-gone",
        tone: "STOP",
        headline: "The edge is gone at the live price",
        detail: `Against the live fill of ${((liveUnitPrice ?? 0) * 100).toFixed(1)}¢ the model sees ${liveNetEdgePoints.toFixed(1)} points${boardEdge !== null ? `, where the board still shows ${boardEdge.toFixed(1)}` : ""}. Buying now means paying more than the estimate is worth.`,
      });
    } else if (boardEdge !== null && liveNetEdgePoints < boardEdge - 0.5) {
      findings.push({
        key: "edge-shrunk",
        tone: "WARNING",
        headline: `The edge has shrunk to ${liveNetEdgePoints.toFixed(1)} points`,
        detail: `The board was showing ${boardEdge.toFixed(1)} points. It is still positive, but less than advertised.`,
      });
    }
  }

  // --- Is the quote backed by anything? --------------------------------------
  if (unitFill && unitFill.bestAskDepthUsd !== null) {
    if (unitFill.bestAskDepthUsd < THIN_BEST_ASK_USD) {
      findings.push({
        key: "thin-top",
        tone: "WARNING",
        headline: `Only ${formatUsdPlain(unitFill.bestAskDepthUsd)} is resting at the best ask`,
        detail: `A $1 order fills, but the quoted price is one small order rather than a market. It can vanish between reading this and placing the bet.`,
      });
    } else {
      findings.push({
        key: "depth-ok",
        tone: "GOOD",
        headline: `${formatUsdPlain(unitFill.bestAskDepthUsd)} is resting at the best ask`,
        detail: `A $1 order fills at ${((unitFill.averagePrice ?? 0) * 100).toFixed(1)}¢ without moving the price.`,
      });
    }
  }

  const fiftyFill = fills.find((f) => f.requestedUsd === 50);
  if (fiftyFill?.slippagePoints !== null && fiftyFill && fiftyFill.slippagePoints! > 2) {
    findings.push({
      key: "shallow-book",
      tone: "WARNING",
      headline: "The book is shallow beyond the top level",
      detail: `A $50 order would average ${((fiftyFill.averagePrice ?? 0) * 100).toFixed(1)}¢, which is ${fiftyFill.slippagePoints!.toFixed(1)} points worse than the best ask. Your dollar is unaffected, but a book this thin reprices easily.`,
    });
  }

  // --- What does covering the whole event cost? ------------------------------
  const overround = computeOverround(input.eventMarkets);
  if (overround) {
    const vig = overround.askOverroundPoints ?? overround.midOverroundPoints;
    const usingAsk = overround.askOverroundPoints !== null;
    const boardEdge = safeNumber(input.boardNetEdgePoints);

    if (vig > 0 && boardEdge !== null && vig >= boardEdge) {
      findings.push({
        key: "vig-exceeds-edge",
        tone: "STOP",
        headline: `The house edge on this event is bigger than the edge being claimed`,
        detail: `Backing all ${overround.legCount} outcomes costs ${(usingAsk ? (overround.askSum ?? 0) : overround.midSum).toFixed(3)} to be certain of $1, so there are ${vig.toFixed(1)} points of built-in cut against ${boardEdge.toFixed(1)} points of claimed edge. A signal smaller than the vig is not beating the market, it is paying it.`,
      });
    } else if (vig > 0) {
      findings.push({
        key: "vig",
        tone: "NEUTRAL",
        headline: `${vig.toFixed(1)} points of house edge across this event`,
        detail: `Backing all ${overround.legCount} outcomes costs ${(usingAsk ? (overround.askSum ?? 0) : overround.midSum).toFixed(3)} to guarantee $1 back${usingAsk ? "" : ", measured on mid prices because at least one leg is too wide to quote"}. Any edge has to clear that first.`,
      });
    } else {
      findings.push({
        key: "underround",
        tone: "GOOD",
        headline: `This event is priced ${Math.abs(vig).toFixed(1)} points under a fair book`,
        detail: `Backing all ${overround.legCount} outcomes costs ${(usingAsk ? (overround.askSum ?? 0) : overround.midSum).toFixed(3)} for a guaranteed $1, so the set is collectively cheap rather than carrying a cut.`,
      });
    }
  }

  // --- Which way is money moving right now? ----------------------------------
  let tape: TapeFlow | null = null;
  try {
    const trades = await fetchTrades({
      market: input.conditionId,
      limit: 500,
      // Taker rows only: the maker's order was already resting, so only the taker chose to trade
      // at this moment. Leaving it off double-counts every fill.
      takerOnly: true,
      ttlMs: TTL.none,
    });
    tape = analyzeTape(
      trades.map((t) => ({
        outcomeIndex: t.outcomeIndex ?? null,
        size: t.size,
        price: t.price,
        timestamp: t.timestamp,
      })),
      input.outcomeIndex,
      input.now,
    );

    // Only a window with real fills AND real dollars behind it may be called a direction. One
    // one-dollar fill is trivially "100% on one side" and says nothing.
    const window = significantWindow(tape);

    if (window === null) {
      findings.push({
        key: "quiet-tape",
        tone: "NEUTRAL",
        headline: "Not enough has traded here to read a direction",
        detail: tape.tooQuiet
          ? "Barely anything has filled in the last day. That is not itself a warning, but it does mean nobody is actively testing this price."
          : "There are fills, but too few dollars behind them in any recent window to tell which way money is leaning.",
      });
    } else if (window.forShare !== null) {
      const pct = Math.round(window.forShare * 100);
      const period = window.hours === 1 ? "hour" : `${window.hours} hours`;
      if (window.netUsd > 0) {
        findings.push({
          key: "flow-with",
          tone: "GOOD",
          headline: `Money in the last ${period} is going your way (${pct}% of it)`,
          detail: `${formatUsdPlain(window.forUsd)} bought ${input.outcomeLabel} against ${formatUsdPlain(window.againstUsd)} on the other side, across ${window.tradeCount} fills. These are aggressive orders — someone chose to cross the spread rather than wait.`,
        });
      } else {
        findings.push({
          key: "flow-against",
          tone: "WARNING",
          headline: `Money in the last ${period} is going the other way (${100 - pct}% of it)`,
          detail: `${formatUsdPlain(window.againstUsd)} bought the other side against ${formatUsdPlain(window.forUsd)} on ${input.outcomeLabel}, across ${window.tradeCount} fills. The tracked positions behind this listing were taken earlier; this is what is happening now.`,
        });
      }
    }
  } catch (error) {
    errors.push(
      `The live trade tape could not be read (${error instanceof Error ? error.message : "unknown error"}).`,
    );
  }

  return {
    checkedAt: input.now.toISOString(),
    liveBestAsk,
    fills,
    liveNetEdgePoints,
    overround,
    tape,
    findings,
    stops: findings.filter((f) => f.tone === "STOP"),
    errors,
  };
}

/** Local so this module does not depend on the formatting layer for one string. */
function formatUsdPlain(value: number): string {
  if (value >= 10_000) return `$${(value / 1000).toFixed(1)}k`;
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}
