/**
 * External Polymarket API shapes.
 *
 * EVERY field in this file was observed in a real production response (see `.research/`, captured
 * by `.research/probe.mjs`). Nothing is invented. If a field is not listed here, we do not use it.
 *
 * These types describe *their* API, not our data model. Conversion happens in `normalize.ts`.
 * Fields are widely optional because Polymarket omits them freely depending on market state.
 */

// ---------------------------------------------------------------------------
// Gamma API — https://gamma-api.polymarket.com
// ---------------------------------------------------------------------------

/**
 * A market as nested inside `GET /events`, and as returned by `GET /markets`.
 *
 * Traps that normalize.ts handles, all verified live:
 *  - `outcomes`, `outcomePrices` and `clobTokenIds` are JSON-ENCODED STRINGS, not arrays.
 *    e.g. outcomes: '["Yes", "No"]'
 *  - `liquidity` and `volume` are strings; `liquidityNum` / `volumeNum` are numbers.
 *  - `liquidityNum` is frequently null on closed markets.
 *  - `spread`, `bestBid`, `bestAsk` are numbers but absent on markets with no book.
 */
export interface GammaMarket {
  id: string;
  question: string;
  conditionId?: string;
  slug?: string;
  description?: string;
  resolutionSource?: string;

  /** JSON-encoded string array, e.g. '["Yes", "No"]' */
  outcomes?: string;
  /** JSON-encoded string array of decimal strings, e.g. '["0.0015", "0.9985"]' */
  outcomePrices?: string;
  /** JSON-encoded string array of CLOB token ids, index-aligned with `outcomes`. */
  clobTokenIds?: string;

  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  volume1yr?: number;
  volumeClob?: number;
  volume24hrClob?: number;

  liquidity?: string;
  liquidityNum?: number;
  liquidityClob?: number;

  spread?: number;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;

  startDate?: string;
  endDate?: string;
  startDateIso?: string;
  endDateIso?: string;
  createdAt?: string;
  updatedAt?: string;

  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  restricted?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  new?: boolean;
  featured?: boolean;
  ready?: boolean;
  funded?: boolean;
  approved?: boolean;

  negRisk?: boolean;
  negRiskMarketID?: string;
  groupItemTitle?: string;
  groupItemThreshold?: string;

  questionID?: string;
  resolvedBy?: string;
  marketMakerAddress?: string;
  umaResolutionStatuses?: string;

  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  rewardsMinSize?: number;
  rewardsMaxSpread?: number;
  competitive?: number;

  image?: string;
  icon?: string;
}

export interface GammaTag {
  id: string;
  label?: string;
  slug?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** `GET /events` — the primary ingestion path. Markets and tags arrive nested. */
export interface GammaEvent {
  id: string;
  ticker?: string;
  slug?: string;
  title?: string;
  description?: string;
  resolutionSource?: string;

  startDate?: string;
  creationDate?: string;
  endDate?: string;
  createdAt?: string;
  updatedAt?: string;

  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  restricted?: boolean;
  featured?: boolean;
  new?: boolean;

  liquidity?: number;
  volume?: number;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  volume1yr?: number;
  openInterest?: number;
  liquidityClob?: number;
  competitive?: number;
  commentCount?: number;

  enableOrderBook?: boolean;
  negRisk?: boolean;
  negRiskMarketID?: string;
  enableNegRisk?: boolean;

  markets?: GammaMarket[];
  tags?: GammaTag[];

  image?: string;
  icon?: string;
}

/** `GET /public-search?q=` */
export interface GammaSearchResponse {
  events?: GammaEvent[];
  pagination?: { hasMore?: boolean; totalResults?: number };
}

// ---------------------------------------------------------------------------
// Data API — https://data-api.polymarket.com
// ---------------------------------------------------------------------------

/**
 * `GET /positions?user={wallet}` — open positions, already enriched with cost basis and PnL.
 * `limit` caps at 500 (verified: requesting 1000 returns 500).
 */
export interface DataPosition {
  proxyWallet: string;
  /** CLOB token id of the outcome held. */
  asset: string;
  conditionId: string;

  /** Shares held. */
  size: number;
  /** Cost basis per share, 0..1. */
  avgPrice: number;
  initialValue?: number;
  grossInitialValue?: number;
  entryFeesUsdc?: number;
  currentValue?: number;
  /** Unrealized PnL in USDC for this open position. */
  cashPnl?: number;
  percentPnl?: number;
  totalBought?: number;
  /** Realized PnL already banked on this asset (e.g. from partial sells). */
  realizedPnl?: number;
  percentRealizedPnl?: number;
  /** Current mark price, 0..1. */
  curPrice?: number;

  redeemable?: boolean;
  mergeable?: boolean;
  negativeRisk?: boolean;

  title?: string;
  slug?: string;
  icon?: string;
  eventId?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
}

/**
 * `GET /closed-positions?user={wallet}` — settled positions. The track record.
 * `limit` caps at 50 (verified: requesting 100 returns 50), so this needs real pagination.
 * `curPrice` is the settlement value: 1 = the held outcome won, 0 = it lost.
 */
export interface DataClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;

  avgPrice?: number;
  totalBought?: number;
  realizedPnl?: number;
  curPrice?: number;

  title?: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
  /** Unix seconds. Settlement/close time. */
  timestamp?: number;
}

export type DataActivityType = "TRADE" | "SPLIT" | "MERGE" | "REDEEM" | "REWARD" | "CONVERSION";
export type DataSide = "BUY" | "SELL";

/**
 * `GET /activity?user={wallet}` — full on-chain action log, not just fills.
 * `limit` caps at 500. Supports `start` / `end` (unix seconds) for incremental sync.
 * This is also where a wallet's public profile name comes from.
 */
export interface DataActivity {
  proxyWallet: string;
  /** Unix seconds. */
  timestamp: number;
  conditionId: string;
  type: DataActivityType;

  /** Shares. Absent/zero on non-trade types. */
  size?: number;
  /** Notional in USDC. */
  usdcSize?: number;
  price?: number;
  asset?: string;
  side?: DataSide;
  outcomeIndex?: number;
  transactionHash?: string;

  title?: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
  outcome?: string;

  // Public profile, opportunistically attached to activity rows.
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
}

/** `GET /value?user={wallet}` returns an array with a single entry. */
export interface DataValue {
  user: string;
  value: number;
}

/** `GET /traded?user={wallet}` — lifetime count of markets traded. */
export interface DataTraded {
  user: string;
  traded: number;
}

export interface DataHolder {
  proxyWallet: string;
  asset?: string;
  amount?: number;
  outcomeIndex?: number;
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
  displayUsernamePublic?: boolean;
  verified?: boolean;
}

/** `GET /holders?market={conditionId}` — one entry per outcome token. */
export interface DataHoldersResponse {
  token: string;
  holders: DataHolder[];
}

/**
 * `GET /v1/leaderboard` — used for trader discovery.
 *
 * VERIFIED CAVEAT: the `window` parameter is accepted but appears to have no effect — `1d`, `7d`,
 * `30d` and `all` returned byte-identical top rows. We therefore treat it as an all-time board and
 * say so in the UI rather than labelling results with a timeframe we cannot substantiate.
 */
export interface DataLeaderboardEntry {
  /** Returned as a string, e.g. "1". */
  rank: string;
  proxyWallet: string;
  userName?: string;
  xUsername?: string;
  verifiedBadge?: boolean;
  vol?: number;
  pnl?: number;
  profileImage?: string;
}

/** `GET /trades` — the global trade tape. Same shape as an activity TRADE row. */
export interface DataTrade {
  proxyWallet: string;
  side: DataSide;
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  transactionHash?: string;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  name?: string;
  pseudonym?: string;
}

// ---------------------------------------------------------------------------
// CLOB API — https://clob.polymarket.com  (READ ONLY)
// ---------------------------------------------------------------------------

export interface ClobBookLevel {
  /** Decimal string. */
  price: string;
  /** Decimal string. */
  size: string;
}

/** `GET /book?token_id=` */
export interface ClobBook {
  market?: string;
  asset_id?: string;
  timestamp?: string;
  hash?: string;
  bids?: ClobBookLevel[];
  asks?: ClobBookLevel[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
  last_trade_price?: string;
}

/** `GET /midpoint?token_id=` -> { mid: "0.003" } */
export interface ClobMidpoint {
  mid?: string;
}

/** `GET /spread?token_id=` -> { spread: "0.004" } */
export interface ClobSpread {
  spread?: string;
}

export interface ClobPricePoint {
  /** Unix seconds. */
  t: number;
  /** Price 0..1. */
  p: number;
}

/**
 * `GET /prices-history?market={CLOB_TOKEN_ID}&interval=&fidelity=`
 *
 * Naming trap: despite the parameter being called `market`, it takes a CLOB TOKEN ID,
 * not a conditionId. This is the backtest's point-in-time price oracle.
 */
export interface ClobPricesHistory {
  history?: ClobPricePoint[];
}
