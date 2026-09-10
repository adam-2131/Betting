/**
 * Activity feed generation.
 *
 * The point is a useful feed, not a transaction dump. Raw fills are already in `TradeActivity`;
 * this layer emits only meaningful state changes and aggregates the noisy ones:
 *   - a position opened, materially increased, materially reduced, or closed
 *   - several qualified traders entering the same market within a short window
 *   - a consensus score moving significantly
 *   - the market price crossing the smart-money average entry
 *
 * Every event carries a `dedupeKey` so re-running a sync cannot duplicate the feed.
 */
import { FeedEventType, type Market, type Position, type Trader } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatUsd, safeNumber, usdPlain } from "@/lib/num";
import type { NormalizedPosition } from "@/lib/polymarket/normalize";

/** Changes smaller than these are noise and are not surfaced. */
const MIN_EVENT_USD = 500;
const MIN_CHANGE_FRACTION = 0.15;

/** A day bucket keeps the dedupe key stable within a sync window without blocking tomorrow's event. */
function dayBucket(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function hourBucket(date = new Date()): string {
  return date.toISOString().slice(0, 13);
}

interface FeedEventInput {
  type: FeedEventType;
  dedupeKey: string;
  occurredAt: Date;
  traderId?: string | null;
  marketId?: string | null;
  outcomeIndex?: number | null;
  headline: string;
  detail?: string | null;
  magnitudeUsd?: number | null;
  importance?: number;
  meta?: Record<string, unknown>;
}

/**
 * Returns true when a new event was written, false when `dedupeKey` already existed.
 *
 * This deliberately uses `createMany({ skipDuplicates })` (`ON CONFLICT DO NOTHING`) rather than
 * `create` inside a try/catch. Letting the insert fail and swallowing the unique violation looks
 * equivalent, but it makes the database raise an error for the ordinary case of "we already have
 * this event", and the local PGlite dev server drops the whole connection when a statement fails
 * mid-batch, taking the rest of the sync down with it. Not raising is both cheaper and safer.
 */
export async function emitFeedEvent(event: FeedEventInput): Promise<boolean> {
  const result = await prisma.feedEvent.createMany({
    data: [
      {
        type: event.type,
        dedupeKey: event.dedupeKey,
        occurredAt: event.occurredAt,
        traderId: event.traderId ?? null,
        marketId: event.marketId ?? null,
        outcomeIndex: event.outcomeIndex ?? null,
        headline: event.headline,
        detail: event.detail ?? null,
        magnitudeUsd: event.magnitudeUsd ?? null,
        importance: event.importance ?? 0,
        meta: (event.meta ?? {}) as object,
      },
    ],
    skipDuplicates: true,
  });
  return result.count > 0;
}

/**
 * Diffs a trader's previous open positions against what the API just returned and emits
 * open/increase/reduce/close events for the material changes.
 */
export async function recordPositionChanges(
  trader: Trader,
  previous: Position[],
  current: NormalizedPosition[],
  markets: Map<string, Market>,
): Promise<number> {
  const previousByAsset = new Map(previous.map((p) => [p.asset, p]));
  const currentByAsset = new Map(current.map((p) => [p.asset, p]));
  const now = new Date();
  let emitted = 0;

  for (const position of current) {
    const market = markets.get(position.conditionId);
    if (!market) continue;

    const before = previousByAsset.get(position.asset);
    const value = safeNumber(position.currentValue) ?? 0;
    const outcomeLabel = position.outcome.toUpperCase();

    if (!before) {
      if (value < MIN_EVENT_USD) continue;
      const price = safeNumber(position.avgPrice);
      emitted += (await emitFeedEvent({
        type: FeedEventType.POSITION_OPENED,
        dedupeKey: `open:${trader.id}:${position.asset}`,
        occurredAt: now,
        traderId: trader.id,
        marketId: market.id,
        outcomeIndex: position.outcomeIndex,
        headline: `${trader.displayName} opened a new ${outcomeLabel} position${
          price !== null ? ` at ${(price * 100).toFixed(0)}¢` : ""
        }.`,
        detail: `${market.question} — ${formatUsd(value)} position.`,
        magnitudeUsd: value,
        importance: value >= 50_000 ? 3 : value >= 10_000 ? 2 : 1,
        meta: { outcome: position.outcome, avgPrice: price },
      }))
        ? 1
        : 0;
      continue;
    }

    const beforeSize = safeNumber(before.size) ?? 0;
    if (beforeSize <= 0) continue;

    const change = (position.size - beforeSize) / beforeSize;
    const beforeValue = safeNumber(before.currentValue) ?? 0;
    const valueDelta = Math.abs(value - beforeValue);

    if (Math.abs(change) < MIN_CHANGE_FRACTION || valueDelta < MIN_EVENT_USD) continue;

    const increased = change > 0;
    emitted += (await emitFeedEvent({
      type: increased ? FeedEventType.POSITION_INCREASED : FeedEventType.POSITION_REDUCED,
      // Bucketed by day so a position that keeps growing produces one event per day, not per sync.
      dedupeKey: `${increased ? "inc" : "dec"}:${trader.id}:${position.asset}:${dayBucket(now)}`,
      occurredAt: now,
      traderId: trader.id,
      marketId: market.id,
      outcomeIndex: position.outcomeIndex,
      headline: `${trader.displayName} ${increased ? "increased" : "reduced"} ${outcomeLabel} exposure by ${formatUsd(valueDelta)}.`,
      detail: `${market.question} — now ${formatUsd(value)} (${increased ? "+" : "−"}${Math.abs(change * 100).toFixed(0)}%).`,
      magnitudeUsd: valueDelta,
      importance: valueDelta >= 50_000 ? 3 : valueDelta >= 10_000 ? 2 : 1,
      meta: { changeFraction: change, outcome: position.outcome },
    }))
      ? 1
      : 0;
  }

  // Positions that disappeared entirely.
  for (const before of previous) {
    if (currentByAsset.has(before.asset)) continue;
    const value = safeNumber(before.currentValue) ?? 0;
    if (value < MIN_EVENT_USD) continue;

    const market = [...markets.values()].find((m) => m.id === before.marketId);
    emitted += (await emitFeedEvent({
      type: FeedEventType.POSITION_CLOSED,
      dedupeKey: `close:${trader.id}:${before.asset}:${dayBucket(now)}`,
      occurredAt: now,
      traderId: trader.id,
      marketId: before.marketId,
      outcomeIndex: before.outcomeIndex,
      headline: `${trader.displayName} exited a ${before.outcome.toUpperCase()} position worth ${formatUsd(value)}.`,
      detail: market?.question ?? null,
      magnitudeUsd: value,
      importance: 2,
    }))
      ? 1
      : 0;
  }

  return emitted;
}

/**
 * Aggregated events computed after scoring: clustered entries, consensus shifts, and the price
 * crossing the smart-money entry. These are the ones worth reading.
 */
export async function recordConsensusEvents(input: {
  marketId: string;
  question: string;
  outcomeIndex: number;
  outcomeLabel: string;
  previousScore: number | null;
  nextScore: number;
  qualifiedTraders: number;
  weightedEntry: number | null;
  currentPrice: number | null;
  recentEntrantCount: number;
}): Promise<number> {
  const now = new Date();
  let emitted = 0;

  // Several qualified traders entering the same market in a short window.
  if (input.recentEntrantCount >= 3) {
    emitted += (await emitFeedEvent({
      type: FeedEventType.CLUSTER_ENTRY,
      dedupeKey: `cluster:${input.marketId}:${input.outcomeIndex}:${dayBucket(now)}`,
      occurredAt: now,
      marketId: input.marketId,
      outcomeIndex: input.outcomeIndex,
      headline: `${input.recentEntrantCount} qualified traders entered the same market within 24 hours.`,
      detail: `${input.question} — all on ${input.outcomeLabel}.`,
      importance: 3,
    }))
      ? 1
      : 0;
  }

  // A meaningful consensus move.
  if (input.previousScore !== null && Math.abs(input.nextScore - input.previousScore) >= 15) {
    emitted += (await emitFeedEvent({
      type: FeedEventType.CONSENSUS_SHIFT,
      dedupeKey: `consensus:${input.marketId}:${input.outcomeIndex}:${hourBucket(now)}`,
      occurredAt: now,
      marketId: input.marketId,
      outcomeIndex: input.outcomeIndex,
      headline: `Smart Money Consensus ${input.nextScore > input.previousScore ? "increased" : "decreased"} from ${Math.round(input.previousScore)} → ${Math.round(input.nextScore)}.`,
      detail: `${input.question} — ${input.outcomeLabel}, ${input.qualifiedTraders} qualified trader${input.qualifiedTraders === 1 ? "" : "s"}.`,
      importance: 2,
    }))
      ? 1
      : 0;
  }

  // The price running past where the smart money got in.
  if (input.weightedEntry !== null && input.currentPrice !== null) {
    const gap = input.currentPrice - input.weightedEntry;
    if (gap >= 0.1) {
      emitted += (await emitFeedEvent({
        type: FeedEventType.PRICE_CROSSED_ELITE_ENTRY,
        dedupeKey: `crossed:${input.marketId}:${input.outcomeIndex}:${dayBucket(now)}`,
        occurredAt: now,
        marketId: input.marketId,
        outcomeIndex: input.outcomeIndex,
        headline: `Market price moved above the tracked average entry by ${(gap * 100).toFixed(0)}¢.`,
        detail: `${input.question} — tracked traders entered around ${(input.weightedEntry * 100).toFixed(0)}¢, the market is now ${(input.currentPrice * 100).toFixed(0)}¢. Entering today is a different trade.`,
        importance: 2,
      }))
        ? 1
        : 0;
    }
  }

  return emitted;
}

export async function recordMarketResolved(
  marketId: string,
  question: string,
  outcomeLabel: string,
  trackedExposureUsd: number,
): Promise<boolean> {
  return emitFeedEvent({
    type: FeedEventType.MARKET_RESOLVED,
    dedupeKey: `resolved:${marketId}`,
    occurredAt: new Date(),
    marketId,
    headline: `Market resolved: ${outcomeLabel} won.`,
    detail: `${question} — ${usdPlain(trackedExposureUsd)} of tracked exposure settled.`,
    magnitudeUsd: trackedExposureUsd,
    importance: 2,
  });
}

/** Trims the feed so it does not grow without bound on a long-running install. */
export async function pruneFeed(keepDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000);
  const result = await prisma.feedEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  return result.count;
}
