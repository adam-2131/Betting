/**
 * WHICH WAY MONEY IS MOVING RIGHT NOW.
 *
 * Consensus is built from tracked traders' POSITIONS, which are a snapshot of who is holding what.
 * That says nothing about the last hour, and for a market settling this evening the last hour is
 * most of what there is to know. This reads the market's own trade tape instead, which includes
 * every wallet rather than only the ones on the watchlist.
 *
 * TWO PROPERTIES OF THE TAPE THAT DECIDE HOW IT HAS TO BE READ, both verified live.
 *
 * DIRECTION IS IN THE OUTCOME, NOT THE SIDE. Every row on a real market came back as `side: BUY`.
 * That is not a bug: on a binary market, selling one outcome is buying the other, and Polymarket
 * normalises to the buy. So net pressure is not buys minus sells, it is dollars buying outcome A
 * against dollars buying outcome B. Reading `side` as direction would report every market as
 * unanimously bullish on everything.
 *
 * `takerOnly` DECIDES WHETHER THE ROWS ARE DOUBLE-COUNTED. With it off, twenty rows contained
 * eleven duplicate transaction hashes — both counterparties to the same fill. With it on, zero.
 * Only the taker chose to trade at that moment; the maker's order had been resting. Aggression is
 * the informative half, so this reads taker rows only.
 *
 * Pure and synchronous. The caller fetches the tape.
 */
import { safeNumber } from "@/lib/num";

export interface TapeTrade {
  outcomeIndex: number | null;
  size: number | null;
  price: number | null;
  /** Unix seconds. */
  timestamp: number | null;
}

export interface TapeWindow {
  hours: number;
  tradeCount: number;
  /** Dollars taken on the side being analysed. */
  forUsd: number;
  /** Dollars taken on every other outcome. */
  againstUsd: number;
  /** forUsd − againstUsd. */
  netUsd: number;
  /** Share of the window's dollars that went to this side, 0..1. Null when nothing traded. */
  forShare: number | null;
  /** Volume-weighted average price paid on this side. Null when nothing traded on it. */
  averagePrice: number | null;
}

export interface TapeFlow {
  /** Windows from tightest to widest, so a shift in the last hour is visible against the day. */
  windows: TapeWindow[];
  /** Largest single fill on this side within the widest window, in dollars. */
  largestForUsd: number | null;
  /** True when the tape is too quiet for any of this to mean anything. */
  tooQuiet: boolean;
  /**
   * Direction of the average price paid on this side, latest window versus widest.
   * Positive means recent takers paid up relative to the period.
   */
  pricePressurePoints: number | null;
}

/** Fewer fills than this in the widest window and the tape is noise. */
const QUIET_TRADE_COUNT = 5;

export const DEFAULT_TAPE_WINDOWS_HOURS = [1, 6, 24] as const;

/**
 * What a window needs before it may be described as having a direction.
 *
 * Both bars exist because either alone lets noise through. A live market produced a single
 * one-dollar fill in the last hour, which is trivially "100% on one side" and means nothing; a
 * different one produced three fills totalling sixty-five dollars, which clears a count test and
 * still is not money moving. Dollars and fills both have to be there.
 */
export const SIGNIFICANT_WINDOW = { minTrades: 3, minUsd: 250 } as const;

/**
 * The tightest window with enough activity to read a direction from, or null.
 *
 * Tightest-first because recency is the whole value — but a confident claim about the last hour
 * built on one fill is worse than a quieter claim about the last six.
 */
export function significantWindow(
  flow: TapeFlow,
  thresholds: { minTrades: number; minUsd: number } = SIGNIFICANT_WINDOW,
): TapeWindow | null {
  for (const window of flow.windows) {
    const volume = window.forUsd + window.againstUsd;
    if (window.tradeCount >= thresholds.minTrades && volume >= thresholds.minUsd) return window;
  }
  return null;
}

function summarise(
  trades: TapeTrade[],
  outcomeIndex: number,
  hours: number,
  now: Date,
): TapeWindow {
  const cutoff = now.getTime() / 1000 - hours * 3600;

  let forUsd = 0;
  let againstUsd = 0;
  let forShares = 0;
  let forNotional = 0;
  let tradeCount = 0;

  for (const trade of trades) {
    const ts = safeNumber(trade.timestamp);
    const size = safeNumber(trade.size);
    const price = safeNumber(trade.price);
    if (ts === null || size === null || price === null) continue;
    if (ts < cutoff) continue;

    const usd = size * price;
    if (usd <= 0) continue;
    tradeCount++;

    if (trade.outcomeIndex === outcomeIndex) {
      forUsd += usd;
      forShares += size;
      forNotional += usd;
    } else {
      againstUsd += usd;
    }
  }

  const total = forUsd + againstUsd;
  return {
    hours,
    tradeCount,
    forUsd,
    againstUsd,
    netUsd: forUsd - againstUsd,
    forShare: total > 0 ? forUsd / total : null,
    averagePrice: forShares > 0 ? forNotional / forShares : null,
  };
}

export function analyzeTape(
  trades: TapeTrade[],
  outcomeIndex: number,
  now: Date,
  windowHours: readonly number[] = DEFAULT_TAPE_WINDOWS_HOURS,
): TapeFlow {
  const windows = windowHours.map((h) => summarise(trades, outcomeIndex, h, now));
  const widest = windows[windows.length - 1];
  const tightest = windows[0];

  const cutoff = now.getTime() / 1000 - (widest?.hours ?? 24) * 3600;
  const forTrades = trades.filter(
    (t) =>
      t.outcomeIndex === outcomeIndex &&
      (safeNumber(t.timestamp) ?? 0) >= cutoff &&
      safeNumber(t.size) !== null &&
      safeNumber(t.price) !== null,
  );

  const largestForUsd =
    forTrades.length > 0
      ? Math.max(...forTrades.map((t) => (safeNumber(t.size) ?? 0) * (safeNumber(t.price) ?? 0)))
      : null;

  const pricePressurePoints =
    tightest?.averagePrice != null && widest?.averagePrice != null
      ? (tightest.averagePrice - widest.averagePrice) * 100
      : null;

  return {
    windows,
    largestForUsd,
    tooQuiet: (widest?.tradeCount ?? 0) < QUIET_TRADE_COUNT,
    pricePressurePoints,
  };
}
