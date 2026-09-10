/**
 * The ONLY bridge between Polymarket's API shapes and PolyAlpha's internal model.
 *
 * Everything ugly about the upstream API is contained here:
 *   - `outcomes` / `outcomePrices` / `clobTokenIds` arrive as JSON-encoded STRINGS
 *   - numbers arrive as strings (`liquidity`) alongside numeric twins (`liquidityNum`)
 *   - missing data is sometimes null, sometimes absent, sometimes an empty string
 *
 * Missing values become `null`, never `0`. A 0 would render as real data; null renders as
 * "Unavailable".
 */
import { Category } from "@prisma/client";
import { safeNumber } from "@/lib/num";
import { resolveCategory } from "./categories";
import { scoreResolutionClarity } from "@/lib/scoring/clarity";
import type {
  DataActivity,
  DataClosedPosition,
  DataPosition,
  GammaEvent,
  GammaMarket,
} from "./types";

// ---------------------------------------------------------------------------
// Primitive parsing
// ---------------------------------------------------------------------------

/**
 * Parses Polymarket's JSON-encoded string arrays. Tolerates a real array (the API has been
 * inconsistent here across endpoints) and returns [] rather than throwing on malformed input.
 */
export function parseJsonArray(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseNumberArray(value: string | string[] | null | undefined): number[] {
  return parseJsonArray(value)
    .map((v) => safeNumber(v))
    .filter((n): n is number => n !== null);
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Unix seconds -> Date. Rejects 0 and negatives, which the API uses as "unset". */
export function parseUnixSeconds(value: number | null | undefined): Date | null {
  const n = safeNumber(value);
  if (n === null || n <= 0) return null;
  return new Date(n * 1000);
}

/** Picks the first non-null candidate. Used for the numeric-twin fields. */
function firstNumber(...candidates: Array<unknown>): number | null {
  for (const candidate of candidates) {
    const n = safeNumber(candidate);
    if (n !== null) return n;
  }
  return null;
}

export function normalizeWallet(address: string): string {
  return address.trim().toLowerCase();
}

export const ETH_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function isValidWallet(address: string): boolean {
  return ETH_ADDRESS_PATTERN.test(address.trim());
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

export interface NormalizedMarket {
  conditionId: string;
  gammaMarketId: string | null;
  question: string;
  slug: string | null;
  eventId: string | null;
  eventSlug: string | null;
  eventTitle: string | null;
  description: string | null;
  resolutionSource: string | null;
  category: Category;
  tags: string[];
  outcomes: string[];
  clobTokenIds: string[];
  prices: number[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  lastTradePrice: number | null;
  liquidity: number | null;
  volume: number | null;
  volume24hr: number | null;
  volume1wk: number | null;
  openInterest: number | null;
  startDate: Date | null;
  endDate: Date | null;
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  negRisk: boolean;
  resolved: boolean;
  resolvedOutcomeIndex: number | null;
  clarityScore: number | null;
  clarityFlags: string[];
}

/**
 * A closed market's `outcomePrices` settle to exactly "1" / "0". That is how we read resolution —
 * there is no dedicated resolution field on the Gamma market object.
 *
 * We require an unambiguous 1 among the prices; anything else (e.g. a closed-but-void market)
 * returns null so it is excluded from win-rate maths rather than counted as a loss.
 */
export function resolveOutcomeIndex(prices: number[], closed: boolean): number | null {
  if (!closed || prices.length === 0) return null;
  const winners = prices
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => Math.abs(p - 1) < 1e-9);
  if (winners.length !== 1) return null;
  return winners[0].i;
}

export function normalizeMarket(
  market: GammaMarket,
  event?: Pick<GammaEvent, "id" | "slug" | "title" | "tags" | "openInterest">,
): NormalizedMarket | null {
  if (!market.conditionId) return null; // unusable without the cross-API key

  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseNumberArray(market.outcomePrices);
  const clobTokenIds = parseJsonArray(market.clobTokenIds);

  const tags = (event?.tags ?? [])
    .map((t) => t.slug || t.label)
    .filter((t): t is string => Boolean(t));

  const closed = market.closed === true;
  const description = market.description ?? null;
  const clarity = scoreResolutionClarity({
    description,
    resolutionSource: market.resolutionSource ?? null,
    question: market.question,
  });

  return {
    conditionId: market.conditionId,
    gammaMarketId: market.id ?? null,
    question: market.question ?? "Unknown market",
    slug: market.slug ?? null,
    eventId: event?.id ?? null,
    eventSlug: event?.slug ?? null,
    eventTitle: event?.title ?? null,
    description,
    resolutionSource: market.resolutionSource ?? null,
    category: resolveCategory(tags, market.question ?? event?.title),
    tags,
    outcomes,
    clobTokenIds,
    prices,
    bestBid: safeNumber(market.bestBid),
    bestAsk: safeNumber(market.bestAsk),
    spread: safeNumber(market.spread),
    lastTradePrice: safeNumber(market.lastTradePrice),
    liquidity: firstNumber(market.liquidityNum, market.liquidity, market.liquidityClob),
    volume: firstNumber(market.volumeNum, market.volume, market.volumeClob),
    volume24hr: firstNumber(market.volume24hr, market.volume24hrClob),
    volume1wk: firstNumber(market.volume1wk),
    openInterest: firstNumber(event?.openInterest),
    startDate: parseDate(market.startDateIso ?? market.startDate),
    endDate: parseDate(market.endDateIso ?? market.endDate),
    active: market.active !== false,
    closed,
    archived: market.archived === true,
    acceptingOrders: market.acceptingOrders !== false,
    enableOrderBook: market.enableOrderBook !== false,
    negRisk: market.negRisk === true,
    resolved: closed && resolveOutcomeIndex(prices, closed) !== null,
    resolvedOutcomeIndex: resolveOutcomeIndex(prices, closed),
    clarityScore: clarity.score,
    clarityFlags: clarity.flags,
  };
}

/** Flattens an events response into normalized markets, carrying event context onto each one. */
export function normalizeEvents(events: GammaEvent[]): NormalizedMarket[] {
  const out: NormalizedMarket[] = [];
  for (const event of events) {
    for (const market of event.markets ?? []) {
      const normalized = normalizeMarket(market, event);
      if (normalized) out.push(normalized);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface NormalizedPosition {
  wallet: string;
  asset: string;
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number | null;
  initialValue: number | null;
  currentValue: number | null;
  cashPnl: number | null;
  percentPnl: number | null;
  /** SHARES bought. The upstream field is called `totalBought` but is not a dollar amount. */
  sharesBought: number | null;
  realizedPnl: number | null;
  curPrice: number | null;
  redeemable: boolean;
  mergeable: boolean;
  negativeRisk: boolean;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  endDate: Date | null;
}

export function normalizePosition(position: DataPosition): NormalizedPosition | null {
  const size = safeNumber(position.size);
  if (!position.asset || !position.conditionId || size === null) return null;

  return {
    wallet: normalizeWallet(position.proxyWallet),
    asset: position.asset,
    conditionId: position.conditionId,
    outcome: position.outcome ?? (position.outcomeIndex === 0 ? "Yes" : "No"),
    outcomeIndex: safeNumber(position.outcomeIndex) ?? 0,
    size,
    avgPrice: safeNumber(position.avgPrice),
    initialValue: safeNumber(position.initialValue),
    currentValue: safeNumber(position.currentValue),
    cashPnl: safeNumber(position.cashPnl),
    percentPnl: safeNumber(position.percentPnl),
    sharesBought: safeNumber(position.totalBought),
    realizedPnl: safeNumber(position.realizedPnl),
    curPrice: safeNumber(position.curPrice),
    redeemable: position.redeemable === true,
    mergeable: position.mergeable === true,
    negativeRisk: position.negativeRisk === true,
    title: position.title ?? null,
    slug: position.slug ?? null,
    eventSlug: position.eventSlug ?? null,
    endDate: parseDate(position.endDate),
  };
}

export interface NormalizedClosedPosition {
  wallet: string;
  asset: string;
  conditionId: string;
  title: string;
  slug: string | null;
  eventSlug: string | null;
  outcome: string;
  outcomeIndex: number;
  avgPrice: number | null;
  /**
   * SHARES bought, not dollars.
   *
   * The upstream field is `totalBought`, which reads like a dollar amount but is not. Verified
   * against 50/50 live rows: for a winner, `realizedPnl == totalBought − totalBought × avgPrice`,
   * which only holds if `totalBought` counts shares. Treating it as dollars inflates every
   * denominator by 1/avgPrice and badly distorts ROI.
   */
  sharesBought: number | null;
  /** USD actually staked == sharesBought × avgPrice. This is the correct ROI denominator. */
  costBasisUsd: number | null;
  realizedPnl: number | null;
  curPrice: number | null;
  /** null when settlement was not a clean 1/0 — excluded from win rate rather than counted. */
  won: boolean | null;
  endDate: Date | null;
  resolvedAt: Date | null;
}

/**
 * On a closed position `curPrice` is the settlement value of the outcome the trader held.
 * 1 = won, 0 = lost. Anything in between means it did not settle cleanly (void, or still
 * settling), and we record `won: null` so it is excluded from win-rate rather than scored as a loss.
 */
export function settlementToWon(curPrice: number | null): boolean | null {
  if (curPrice === null) return null;
  if (Math.abs(curPrice - 1) < 1e-6) return true;
  if (Math.abs(curPrice) < 1e-6) return false;
  return null;
}

export function normalizeClosedPosition(
  position: DataClosedPosition,
): NormalizedClosedPosition | null {
  if (!position.asset || !position.conditionId) return null;
  const curPrice = safeNumber(position.curPrice);
  const avgPrice = safeNumber(position.avgPrice);
  const sharesBought = safeNumber(position.totalBought);
  const costBasisUsd =
    sharesBought !== null && avgPrice !== null && avgPrice > 0 ? sharesBought * avgPrice : null;

  return {
    wallet: normalizeWallet(position.proxyWallet),
    asset: position.asset,
    conditionId: position.conditionId,
    title: position.title ?? "Unknown market",
    slug: position.slug ?? null,
    eventSlug: position.eventSlug ?? null,
    outcome: position.outcome ?? (position.outcomeIndex === 0 ? "Yes" : "No"),
    outcomeIndex: safeNumber(position.outcomeIndex) ?? 0,
    avgPrice,
    sharesBought,
    costBasisUsd,
    realizedPnl: safeNumber(position.realizedPnl),
    curPrice,
    won: settlementToWon(curPrice),
    endDate: parseDate(position.endDate),
    resolvedAt: parseUnixSeconds(position.timestamp),
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface NormalizedActivity {
  wallet: string;
  dedupeKey: string;
  transactionHash: string | null;
  timestamp: number;
  occurredAt: Date;
  conditionId: string;
  type: "TRADE" | "SPLIT" | "MERGE" | "REDEEM" | "REWARD" | "CONVERSION" | "OTHER";
  side: "BUY" | "SELL" | null;
  size: number | null;
  usdcSize: number | null;
  price: number | null;
  asset: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  profileName: string | null;
  avatarUrl: string | null;
}

const ACTIVITY_TYPES = new Set(["TRADE", "SPLIT", "MERGE", "REDEEM", "REWARD", "CONVERSION"]);

export function normalizeActivity(activity: DataActivity): NormalizedActivity | null {
  const timestamp = safeNumber(activity.timestamp);
  if (timestamp === null || timestamp <= 0 || !activity.conditionId) return null;

  const type = ACTIVITY_TYPES.has(activity.type)
    ? (activity.type as NormalizedActivity["type"])
    : "OTHER";
  const wallet = normalizeWallet(activity.proxyWallet);
  const size = safeNumber(activity.size);

  // /activity pages overlap, and a single transaction can contain several fills, so the tx hash
  // alone is not unique. This composite is.
  const dedupeKey = [
    wallet,
    activity.transactionHash ?? "no-tx",
    activity.asset ?? activity.conditionId,
    type,
    activity.side ?? "-",
    timestamp,
    size ?? 0,
  ].join(":");

  return {
    wallet,
    dedupeKey,
    transactionHash: activity.transactionHash ?? null,
    timestamp,
    occurredAt: new Date(timestamp * 1000),
    conditionId: activity.conditionId,
    type,
    side: activity.side === "BUY" || activity.side === "SELL" ? activity.side : null,
    size,
    usdcSize: safeNumber(activity.usdcSize),
    price: safeNumber(activity.price),
    asset: activity.asset ?? null,
    outcome: activity.outcome ?? null,
    outcomeIndex: safeNumber(activity.outcomeIndex),
    title: activity.title ?? null,
    slug: activity.slug ?? null,
    eventSlug: activity.eventSlug ?? null,
    profileName: activity.name || activity.pseudonym || null,
    avatarUrl: activity.profileImage || null,
  };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The only "action" affordance in the product: a link out to Polymarket. */
export function polymarketMarketUrl(slug: string | null, eventSlug: string | null): string {
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
  if (slug) return `https://polymarket.com/market/${slug}`;
  return "https://polymarket.com";
}

export function polymarketProfileUrl(wallet: string): string {
  return `https://polymarket.com/profile/${normalizeWallet(wallet)}`;
}
