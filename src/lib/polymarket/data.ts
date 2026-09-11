/**
 * Data API client — the smart-money core.
 * https://data-api.polymarket.com
 *
 * Public, keyless, read-only. Page-size ceilings below were measured against production, not read
 * off a docs page:
 *   /positions        limit caps at 500 (asking for 1000 returns 500)
 *   /closed-positions limit caps at  50 (asking for  100 returns  50)
 *   /activity         limit caps at 500
 */
import { apiGet, paginate, TTL } from "./http";
import type {
  DataActivity,
  DataClosedPosition,
  DataHoldersResponse,
  DataLeaderboardEntry,
  DataPosition,
  DataTrade,
  DataTraded,
  DataValue,
} from "./types";
import { normalizeWallet } from "./normalize";

const POSITIONS_PAGE_SIZE = 500;
const CLOSED_POSITIONS_PAGE_SIZE = 50;
const ACTIVITY_PAGE_SIZE = 500;

/** Open positions, already enriched by Polymarket with cost basis and PnL. */
export async function fetchPositions(
  wallet: string,
  options: { maxItems?: number; ttlMs?: number } = {},
): Promise<DataPosition[]> {
  return paginate<DataPosition>("data", "/positions", {
    pageSize: POSITIONS_PAGE_SIZE,
    maxItems: options.maxItems ?? 1500,
    ttlMs: options.ttlMs ?? TTL.positions,
    params: {
      user: normalizeWallet(wallet),
      sizeThreshold: 0.1,
      sortBy: "CURRENT",
      sortDirection: "DESC",
    },
  });
}

/**
 * Settled positions — a trader's actual track record.
 * Paginates in 50s, so a deep history costs real requests; `maxItems` bounds that.
 */
export async function fetchClosedPositions(
  wallet: string,
  options: { maxItems?: number; ttlMs?: number } = {},
): Promise<DataClosedPosition[]> {
  return paginate<DataClosedPosition>("data", "/closed-positions", {
    pageSize: CLOSED_POSITIONS_PAGE_SIZE,
    maxItems: options.maxItems ?? 1000,
    ttlMs: options.ttlMs ?? TTL.closedPositions,
    params: {
      user: normalizeWallet(wallet),
      sortBy: "TIMESTAMP",
      sortDirection: "DESC",
    },
  });
}

/**
 * On-chain action log. `since` (unix seconds) makes syncs incremental — we store the highest
 * timestamp already ingested per trader and only ask for newer rows.
 */
export async function fetchActivity(
  wallet: string,
  options: { since?: number | null; until?: number | null; maxItems?: number; ttlMs?: number } = {},
): Promise<DataActivity[]> {
  return paginate<DataActivity>("data", "/activity", {
    pageSize: ACTIVITY_PAGE_SIZE,
    maxItems: options.maxItems ?? 2000,
    ttlMs: options.ttlMs ?? TTL.activity,
    params: {
      user: normalizeWallet(wallet),
      start: options.since ?? undefined,
      end: options.until ?? undefined,
      sortBy: "TIMESTAMP",
      sortDirection: "DESC",
    },
  });
}

/** Portfolio value. The endpoint returns a single-element array. */
export async function fetchPortfolioValue(wallet: string): Promise<number | null> {
  const result = await apiGet<DataValue[] | null>("data", "/value", {
    params: { user: normalizeWallet(wallet) },
    ttlMs: TTL.positions,
  });
  const value = Array.isArray(result) ? result[0]?.value : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Lifetime count of markets traded. */
export async function fetchTradedCount(wallet: string): Promise<number | null> {
  const result = await apiGet<DataTraded | null>("data", "/traded", {
    params: { user: normalizeWallet(wallet) },
    ttlMs: TTL.positions,
  });
  const traded = result?.traded;
  return typeof traded === "number" && Number.isFinite(traded) ? traded : null;
}

/**
 * Top holders per outcome token. Our secondary trader-discovery mechanism.
 * Returns null (not an error) for an unknown condition id, hence the array guard.
 */
export async function fetchHolders(
  conditionId: string,
  limit = 20,
): Promise<DataHoldersResponse[]> {
  const result = await apiGet<DataHoldersResponse[] | null>("data", "/holders", {
    params: { market: conditionId, limit },
    ttlMs: 5 * 60_000,
    nullOn404: true,
  });
  return Array.isArray(result) ? result : [];
}

/**
 * Leaderboard — the primary trader-discovery mechanism.
 *
 * VERIFIED CAVEAT: the `window` parameter is accepted but has no observable effect. Requests for
 * 1d/7d/30d/all returned identical rows, so callers must treat this as an all-time board. The UI
 * says so rather than labelling the results with a timeframe we cannot substantiate.
 */
export async function fetchLeaderboard(limit = 50): Promise<DataLeaderboardEntry[]> {
  const result = await apiGet<DataLeaderboardEntry[] | null>("data", "/v1/leaderboard", {
    params: { limit },
    ttlMs: TTL.leaderboard,
  });
  return Array.isArray(result) ? result : [];
}

/**
 * Global trade tape, optionally scoped to a market or user.
 *
 * `offset` pages backwards through the tape; verified against production that consecutive pages
 * do not overlap. Note that a single fill appears TWICE, once for each counterparty — the buyer
 * and the seller are separate rows sharing a transaction hash — so callers counting distinct
 * wallets get both sides of every trade, which is what trader discovery wants.
 */
export async function fetchTrades(
  options: { user?: string; market?: string; limit?: number; offset?: number } = {},
): Promise<DataTrade[]> {
  const result = await apiGet<DataTrade[] | null>("data", "/trades", {
    params: {
      user: options.user ? normalizeWallet(options.user) : undefined,
      market: options.market,
      limit: options.limit ?? 100,
      offset: options.offset,
      takerOnly: false,
    },
    ttlMs: TTL.activity,
  });
  return Array.isArray(result) ? result : [];
}
