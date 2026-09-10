/**
 * CLOB API client — READ ONLY.
 * https://clob.polymarket.com
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  HARD RULE: this module must never gain an order-placement function.
 *  PolyAlpha does not create orders, does not sign, does not connect a wallet.
 *  No API-key derivation, no L1/L2 headers, no POST. Reads only.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { apiGet, TTL } from "./http";
import { safeNumber } from "@/lib/num";
import type { ClobBook, ClobMidpoint, ClobPricePoint, ClobPricesHistory, ClobSpread } from "./types";

export interface BookDepth {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  midpoint: number | null;
  /** Sum of bid size × price, i.e. dollars resting on the bid. */
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
}

export async function fetchBook(tokenId: string): Promise<ClobBook | null> {
  return apiGet<ClobBook | null>("clob", "/book", {
    params: { token_id: tokenId },
    ttlMs: TTL.book,
    nullOn404: true,
  });
}

/**
 * Derives execution quality from the raw book.
 * Bids arrive ascending and asks descending, so we take the extremes rather than index 0.
 */
export function summarizeBook(book: ClobBook | null): BookDepth {
  const empty: BookDepth = {
    bestBid: null,
    bestAsk: null,
    spread: null,
    midpoint: null,
    bidDepthUsd: null,
    askDepthUsd: null,
  };
  if (!book) return empty;

  const bids = (book.bids ?? [])
    .map((l) => ({ price: safeNumber(l.price), size: safeNumber(l.size) }))
    .filter((l): l is { price: number; size: number } => l.price !== null && l.size !== null);
  const asks = (book.asks ?? [])
    .map((l) => ({ price: safeNumber(l.price), size: safeNumber(l.size) }))
    .filter((l): l is { price: number; size: number } => l.price !== null && l.size !== null);

  const bestBid = bids.length ? Math.max(...bids.map((l) => l.price)) : null;
  const bestAsk = asks.length ? Math.min(...asks.map((l) => l.price)) : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const midpoint = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;

  return {
    bestBid,
    bestAsk,
    spread,
    midpoint,
    bidDepthUsd: bids.length ? bids.reduce((acc, l) => acc + l.price * l.size, 0) : null,
    askDepthUsd: asks.length ? asks.reduce((acc, l) => acc + (1 - l.price) * l.size, 0) : null,
  };
}

export async function fetchMidpoint(tokenId: string): Promise<number | null> {
  const result = await apiGet<ClobMidpoint | null>("clob", "/midpoint", {
    params: { token_id: tokenId },
    ttlMs: TTL.book,
    nullOn404: true,
  });
  return safeNumber(result?.mid);
}

export async function fetchSpread(tokenId: string): Promise<number | null> {
  const result = await apiGet<ClobSpread | null>("clob", "/spread", {
    params: { token_id: tokenId },
    ttlMs: TTL.book,
    nullOn404: true,
  });
  return safeNumber(result?.spread);
}

export type PriceHistoryInterval = "1m" | "1w" | "1d" | "6h" | "1h" | "max";

/**
 * Historical price series — the backtest's point-in-time price oracle.
 *
 * NAMING TRAP: the `market` parameter takes a CLOB TOKEN ID, not a conditionId.
 * `fidelity` is the resolution in minutes.
 */
export async function fetchPriceHistory(
  tokenId: string,
  options: { interval?: PriceHistoryInterval; fidelity?: number; startTs?: number; endTs?: number } = {},
): Promise<ClobPricePoint[]> {
  const { interval = "max", fidelity = 60, startTs, endTs } = options;

  const result = await apiGet<ClobPricesHistory | null>("clob", "/prices-history", {
    params: {
      market: tokenId,
      // startTs/endTs and interval are mutually exclusive upstream.
      interval: startTs || endTs ? undefined : interval,
      startTs,
      endTs,
      fidelity,
    },
    ttlMs: TTL.priceHistory,
    nullOn404: true,
  });

  const history = result?.history;
  if (!Array.isArray(history)) return [];

  return history
    .map((point) => ({ t: safeNumber(point.t), p: safeNumber(point.p) }))
    .filter((point): point is ClobPricePoint => point.t !== null && point.p !== null)
    .sort((a, b) => a.t - b.t);
}

/**
 * The price as of a moment in the past — strictly the last sample AT OR BEFORE `atUnixSeconds`.
 *
 * This "at or before" rule is the mechanical guarantee against look-ahead bias in the backtest:
 * it is structurally impossible for this function to return a price from the future.
 */
export function priceAt(history: ClobPricePoint[], atUnixSeconds: number): number | null {
  if (history.length === 0) return null;

  let result: number | null = null;
  // history is sorted ascending by fetchPriceHistory.
  for (const point of history) {
    if (point.t > atUnixSeconds) break;
    result = point.p;
  }
  return result;
}
