/**
 * The single HTTP core behind all three Polymarket clients.
 *
 * Responsibilities, all in one place so no individual client can get them wrong:
 *   - per-host token-bucket rate limiting, configured well under the published limits
 *   - bounded concurrency per host
 *   - retries with exponential backoff + jitter on 429/5xx/network errors, honouring Retry-After
 *   - an in-process TTL cache with LRU eviction
 *   - limit/offset pagination that stops on a short page and can never loop forever
 *
 * Deliberately not Redis and not a job queue: this is a single-user local research tool.
 */

export type Host = "gamma" | "data" | "clob";

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const API_BASE: Record<Host, string> = {
  gamma: process.env.GAMMA_API_URL ?? "https://gamma-api.polymarket.com",
  data: process.env.DATA_API_URL ?? "https://data-api.polymarket.com",
  clob: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
};

/**
 * Requests per second per host. The Data API's documented ceiling is far higher (~1000 req/10s
 * overall, ~150/10s on /positions) but there is no upside to running near it from one desktop.
 */
const RATE_LIMIT_RPS: Record<Host, number> = {
  gamma: envNum("GAMMA_RATE_LIMIT_RPS", 8),
  data: envNum("DATA_RATE_LIMIT_RPS", 6),
  clob: envNum("CLOB_RATE_LIMIT_RPS", 8),
};

const MAX_CONCURRENCY = envNum("POLYMARKET_MAX_CONCURRENCY", 4);
const MAX_RETRIES = envNum("POLYMARKET_MAX_RETRIES", 4);
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const REQUEST_TIMEOUT_MS = envNum("POLYMARKET_TIMEOUT_MS", 30_000);

// ---------------------------------------------------------------------------
// Rate limiting + concurrency
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(
    private readonly rps: number,
    private readonly maxConcurrent: number,
  ) {
    this.tokens = rps;
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.rps, this.tokens + elapsed * this.rps);
    this.lastRefill = now;
  }

  async acquire(): Promise<() => void> {
    // Wait for a concurrency slot.
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;

    // Wait for a rate-limit token.
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        break;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.rps) * 1000);
      await sleep(Math.max(waitMs, 10));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

const buckets: Record<Host, TokenBucket> = {
  gamma: new TokenBucket(RATE_LIMIT_RPS.gamma, MAX_CONCURRENCY),
  data: new TokenBucket(RATE_LIMIT_RPS.data, MAX_CONCURRENCY),
  clob: new TokenBucket(RATE_LIMIT_RPS.clob, MAX_CONCURRENCY),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 2000;
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Refresh LRU recency.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: unknown, ttlMs: number) {
  if (ttlMs <= 0) return;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function clearApiCache() {
  cache.clear();
}

/** Default TTLs by data volatility. Overridable per call. */
export const TTL = {
  markets: 60_000,
  book: 15_000,
  positions: 60_000,
  closedPositions: 10 * 60_000,
  activity: 60_000,
  priceHistory: 60 * 60_000,
  leaderboard: 15 * 60_000,
  none: 0,
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PolymarketApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(message);
    this.name = "PolymarketApiError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
  }
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Full jitter avoids a thundering herd when a whole sync pass gets 429'd at once.
  return Math.random() * exponential;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface RequestOptions {
  /** Query params. Undefined and null values are dropped; arrays become comma-separated. */
  params?: Record<string, string | number | boolean | undefined | null | Array<string | number>>;
  ttlMs?: number;
  /** Treat a 404 as "no data" and resolve to null instead of throwing. */
  nullOn404?: boolean;
  signal?: AbortSignal;
}

export function buildUrl(host: Host, path: string, params?: RequestOptions["params"]): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, API_BASE[host]);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return url.toString();
}

export async function apiGet<T>(host: Host, path: string, options: RequestOptions = {}): Promise<T> {
  const url = buildUrl(host, path, options.params);
  const ttlMs = options.ttlMs ?? TTL.markets;

  const cached = cacheGet(url);
  if (cached !== undefined) return cached as T;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const release = await buckets[host].acquire();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "PolyAlpha/1.0 (personal research)" },
        signal: options.signal ?? timeout.signal,
      });

      if (res.status === 404 && options.nullOn404) {
        return null as T;
      }

      if (!res.ok) {
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
          const wait = backoffMs(attempt, res.headers.get("retry-after"));
          release();
          clearTimeout(timer);
          await sleep(wait);
          continue;
        }
        const body = await res.text().catch(() => "");
        throw new PolymarketApiError(
          `${host} ${res.status} ${res.statusText} — ${path}${body ? `: ${body.slice(0, 200)}` : ""}`,
          res.status,
          url,
        );
      }

      const text = await res.text();
      // Some endpoints legitimately answer `null` (e.g. /holders for an unknown condition id).
      const parsed = text.trim() === "" ? null : (JSON.parse(text) as T);
      cacheSet(url, parsed, ttlMs);
      return parsed as T;
    } catch (err) {
      lastError = err;
      if (err instanceof PolymarketApiError) throw err;
      if (attempt < MAX_RETRIES) {
        release();
        clearTimeout(timer);
        await sleep(backoffMs(attempt, null));
        continue;
      }
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  throw new PolymarketApiError(
    `${host} request failed after ${MAX_RETRIES + 1} attempts — ${path}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    null,
    url,
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginateOptions extends RequestOptions {
  /** Page size. Must respect the endpoint's real ceiling (positions 500, closed-positions 50). */
  pageSize: number;
  /** Stop after this many items regardless. */
  maxItems?: number;
  /** Hard stop so a bad filter can never spin. */
  maxPages?: number;
}

/**
 * Walks `limit`/`offset` until a short page arrives. Every Polymarket list endpoint we use follows
 * this convention.
 */
export async function paginate<T>(
  host: Host,
  path: string,
  options: PaginateOptions,
): Promise<T[]> {
  const { pageSize, maxItems = Infinity, maxPages = 200, params, ...rest } = options;
  const out: T[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const batch = await apiGet<T[] | null>(host, path, {
      ...rest,
      params: { ...params, limit: pageSize, offset },
    });

    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);

    if (batch.length < pageSize) break;
    if (out.length >= maxItems) return out.slice(0, maxItems);
  }

  return out.length > maxItems ? out.slice(0, maxItems) : out;
}
