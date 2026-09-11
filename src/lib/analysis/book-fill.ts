/**
 * WHAT YOU WOULD ACTUALLY FILL AT.
 *
 * Everywhere else the product treats `bestAsk` as the price. That is the price of the CHEAPEST
 * RESTING ORDER, for whatever size happens to be sitting there, and nothing guarantees the size is
 * meaningful. A book can show a one-cent spread with eleven dollars behind it.
 *
 * This walks the real ask ladder and reports the average price a given stake would actually pay,
 * which is the only number a decision should be made on. For a one-dollar stake the answer is
 * almost always the best ask — the point is not to correct that dollar, it is to expose the books
 * where the quote is decoration. A market whose top level holds $12 is telling you something about
 * itself that its spread is hiding.
 *
 * Pure and synchronous. The caller fetches the book.
 */
import { safeNumber } from "@/lib/num";

export interface BookLevel {
  price: number;
  /** Shares resting at this price. */
  size: number;
}

export interface FillResult {
  /** Stake requested. */
  requestedUsd: number;
  /** Stake actually fillable from the visible book. */
  filledUsd: number;
  /** Left over when the book runs out. Non-zero means the book cannot absorb the order. */
  unfilledUsd: number;
  shares: number;
  /** Volume-weighted average price actually paid. */
  averagePrice: number | null;
  /** Cheapest resting ask, for comparison. */
  bestAsk: number | null;
  /** Worst price touched to complete the fill. */
  worstPrice: number | null;
  /** averagePrice − bestAsk, in probability points. Zero when the top level absorbs the order. */
  slippagePoints: number | null;
  /** How many price levels the order eats through. */
  levelsConsumed: number;
  /** Dollars resting at the best ask alone. */
  bestAskDepthUsd: number | null;
  /** Total dollars resting across every visible ask level. */
  totalAskDepthUsd: number;
}

/** Parses and sorts raw CLOB levels, discarding anything unusable. */
export function normalizeAsks(levels: Array<{ price: unknown; size: unknown }>): BookLevel[] {
  return levels
    .map((l) => ({ price: safeNumber(l.price), size: safeNumber(l.size) }))
    .filter(
      (l): l is BookLevel =>
        l.price !== null && l.size !== null && l.price > 0 && l.price < 1 && l.size > 0,
    )
    .sort((a, b) => a.price - b.price);
}

/**
 * Walks the ask ladder cheapest-first, spending `stakeUsd`.
 *
 * Buying shares costs `price × size` dollars, so each level absorbs a different number of dollars
 * than it does shares. Spending the budget rather than filling a share count is the right model
 * here: a bettor decides how much money to risk, not how many shares to own.
 */
export function simulateFill(asks: BookLevel[], stakeUsd: number): FillResult {
  const requested = safeNumber(stakeUsd) ?? 0;
  const sorted = [...asks].sort((a, b) => a.price - b.price);

  const totalAskDepthUsd = sorted.reduce((acc, l) => acc + l.price * l.size, 0);
  const bestAsk = sorted.length > 0 ? sorted[0].price : null;
  const bestAskDepthUsd = sorted.length > 0 ? sorted[0].price * sorted[0].size : null;

  const empty: FillResult = {
    requestedUsd: requested,
    filledUsd: 0,
    unfilledUsd: requested,
    shares: 0,
    averagePrice: null,
    bestAsk,
    worstPrice: null,
    slippagePoints: null,
    levelsConsumed: 0,
    bestAskDepthUsd,
    totalAskDepthUsd,
  };

  if (requested <= 0 || sorted.length === 0) return empty;

  let remaining = requested;
  let shares = 0;
  let levelsConsumed = 0;
  let worstPrice: number | null = null;

  for (const level of sorted) {
    if (remaining <= 1e-9) break;
    const levelUsd = level.price * level.size;
    levelsConsumed++;
    worstPrice = level.price;

    if (levelUsd >= remaining) {
      shares += remaining / level.price;
      remaining = 0;
      break;
    }

    shares += level.size;
    remaining -= levelUsd;
  }

  const filledUsd = requested - remaining;
  if (shares <= 0) return empty;

  const averagePrice = filledUsd / shares;

  return {
    requestedUsd: requested,
    filledUsd,
    unfilledUsd: remaining,
    shares,
    averagePrice,
    bestAsk,
    worstPrice,
    slippagePoints: bestAsk === null ? null : (averagePrice - bestAsk) * 100,
    levelsConsumed,
    bestAskDepthUsd,
    totalAskDepthUsd,
  };
}

/**
 * The stakes a fill is reported at.
 *
 * $1 is the reader's actual bet. The larger two exist to characterise the book rather than to
 * suggest betting them: if $50 moves the price materially, the quote is thin regardless of what
 * the one-dollar fill says.
 */
export const FILL_LADDER_USD = [1, 10, 50] as const;
