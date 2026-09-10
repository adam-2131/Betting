/**
 * Gamma API client — market and event discovery.
 * https://gamma-api.polymarket.com
 *
 * Read-only. Returns raw external types; conversion is the caller's job via `normalize.ts`.
 */
import { apiGet, paginate, TTL } from "./http";
import type { GammaEvent, GammaMarket, GammaSearchResponse, GammaTag } from "./types";

const EVENTS_PAGE_SIZE = 100;
const MARKETS_PAGE_SIZE = 100;

export interface FetchEventsOptions {
  limit?: number;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  /** Server-side sort field, e.g. "volume24hr", "liquidity", "endDate". */
  order?: string;
  ascending?: boolean;
  tagSlug?: string;
  endDateMin?: string;
  endDateMax?: string;
  ttlMs?: number;
}

/**
 * The primary ingestion path: events arrive with `markets[]` and `tags[]` nested, so one call
 * yields market metadata, pricing and the tags we derive categories from.
 */
export async function fetchEvents(options: FetchEventsOptions = {}): Promise<GammaEvent[]> {
  const {
    limit = 500,
    active = true,
    closed = false,
    archived = false,
    order = "volume24hr",
    ascending = false,
    tagSlug,
    endDateMin,
    endDateMax,
    ttlMs = TTL.markets,
  } = options;

  return paginate<GammaEvent>("gamma", "/events", {
    pageSize: Math.min(EVENTS_PAGE_SIZE, limit),
    maxItems: limit,
    ttlMs,
    params: {
      active,
      closed,
      archived,
      order,
      ascending,
      tag_slug: tagSlug,
      end_date_min: endDateMin,
      end_date_max: endDateMax,
    },
  });
}

export interface FetchMarketsOptions {
  limit?: number;
  closed?: boolean;
  active?: boolean;
  order?: string;
  ascending?: boolean;
  /** Filter to specific condition ids. Repeated as multiple `condition_ids` params. */
  conditionIds?: string[];
  endDateMin?: string;
  endDateMax?: string;
  ttlMs?: number;
}

export async function fetchMarkets(options: FetchMarketsOptions = {}): Promise<GammaMarket[]> {
  const {
    limit = 200,
    closed,
    active,
    order = "volumeNum",
    ascending = false,
    endDateMin,
    endDateMax,
    ttlMs = TTL.markets,
  } = options;

  return paginate<GammaMarket>("gamma", "/markets", {
    pageSize: Math.min(MARKETS_PAGE_SIZE, limit),
    maxItems: limit,
    ttlMs,
    params: {
      closed,
      active,
      order,
      ascending,
      end_date_min: endDateMin,
      end_date_max: endDateMax,
    },
  });
}

/**
 * Looks markets up by condition id. Gamma accepts repeated `condition_ids` params, so this batches
 * rather than issuing one request per id.
 *
 * VERIFIED TRAP: `/markets?condition_ids=X` returns an empty array — HTTP 200, no error — for a
 * market that has closed. The endpoint applies an implicit open-markets filter, and only returns
 * a settled market when `closed=true` is passed explicitly. Since a trader's settled record is
 * entirely closed markets, omitting the second pass silently loses almost all of the history the
 * track record and the backtest are built on. So each batch is queried twice: once as-is, then
 * again with `closed=true` for whatever the first pass did not return.
 */
export async function fetchMarketsByConditionIds(
  conditionIds: string[],
  batchSize = 20,
): Promise<GammaMarket[]> {
  const unique = [...new Set(conditionIds.filter(Boolean))];
  const out: GammaMarket[] = [];
  const found = new Set<string>();

  const runBatch = async (batch: string[], closed: boolean) => {
    if (batch.length === 0) return;
    const query = batch.map((id) => `condition_ids=${encodeURIComponent(id)}`).join("&");
    const suffix = closed ? "&closed=true" : "";
    const result = await apiGet<GammaMarket[] | null>(
      "gamma",
      `/markets?${query}&limit=${batch.length}${suffix}`,
      { ttlMs: TTL.markets },
    );
    if (!Array.isArray(result)) return;
    for (const market of result) {
      if (market.conditionId) found.add(market.conditionId);
      out.push(market);
    }
  };

  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    await runBatch(batch, false);
    await runBatch(
      batch.filter((id) => !found.has(id)),
      true,
    );
  }

  return out;
}

export async function fetchTags(limit = 500): Promise<GammaTag[]> {
  const result = await apiGet<GammaTag[] | null>("gamma", "/tags", {
    params: { limit },
    ttlMs: 60 * 60_000,
  });
  return Array.isArray(result) ? result : [];
}

/** Free-text search over events/markets. Used by the market lookup helper. */
export async function searchMarkets(query: string, limitPerType = 10): Promise<GammaEvent[]> {
  if (!query.trim()) return [];
  const result = await apiGet<GammaSearchResponse | null>("gamma", "/public-search", {
    params: { q: query, limit_per_type: limitPerType },
    ttlMs: 5 * 60_000,
  });
  return result?.events ?? [];
}

/**
 * Closed markets ordered by volume — the universe the backtest replays over.
 * Only markets that actually resolved are useful, so callers filter on `outcomePrices`.
 */
export async function fetchClosedMarkets(options: {
  limit?: number;
  endDateMin?: string;
  endDateMax?: string;
} = {}): Promise<GammaMarket[]> {
  return fetchMarkets({
    limit: options.limit ?? 500,
    closed: true,
    order: "volumeNum",
    ascending: false,
    endDateMin: options.endDateMin,
    endDateMax: options.endDateMax,
    ttlMs: 30 * 60_000,
  });
}
