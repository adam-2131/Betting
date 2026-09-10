# PolyAlpha — Architecture

PolyAlpha is a **read-only** Polymarket intelligence dashboard for personal research.

It answers one question:

> *What are historically strong Polymarket traders doing right now, and which of those signals are still interesting at today's price?*

It never places orders, never connects a wallet, never asks for keys or seed phrases, and never signs
a transaction. The only "action" affordance in the whole product is a `VIEW ON POLYMARKET` link.

---

## 1. API research — what actually exists (verified live)

Every endpoint below was called against production before any code was written. Sample payloads live
in `.research/` (git-ignored) and the field lists were transcribed into `src/lib/polymarket/types.ts`.

### 1.1 Gamma API — `https://gamma-api.polymarket.com`

Public, unauthenticated. Market/event discovery and metadata.

| Endpoint | Purpose | Key fields we consume |
| --- | --- | --- |
| `GET /events` | Primary ingestion path. Returns events **with nested `markets[]` and `tags[]`**. | `id, slug, title, liquidity, volume, volume24hr, openInterest, endDate, closed, active, tags[], markets[]` |
| `GET /markets` | Individual market lookup / closed-market backfill. | see below |
| `GET /public-search?q=` | Free-text market + profile search. | used by the "Add trader" / market search helpers |

Verified market fields (from a live response):

```
id, question, conditionId, slug, resolutionSource, endDate, startDate, description,
outcomes ("[\"Yes\", \"No\"]" — JSON-encoded string, NOT an array),
outcomePrices ("[\"0.003\", \"0.997\"]" — also a JSON-encoded string),
clobTokenIds ("[\"271469…\", \"332166…\"]" — also a JSON-encoded string),
volume, volumeNum, volume24hr, volume1wk, volume1mo,
liquidity, liquidityNum, liquidityClob,
spread, bestBid, bestAsk, lastTradePrice,
oneDayPriceChange, oneWeekPriceChange, oneMonthPriceChange,
active, closed, archived, restricted, acceptingOrders, enableOrderBook,
negRisk, negRiskMarketID, groupItemTitle, orderPriceMinTickSize, orderMinSize,
umaResolutionStatuses, resolvedBy, questionID, createdAt, updatedAt
```

> **Gotcha, and the reason we hand-wrote the types:** `outcomes`, `outcomePrices` and `clobTokenIds`
> are **JSON-encoded strings**, not arrays. `liquidityNum` is sometimes `null` on closed markets.
> `volume` is a string while `volumeNum` is a number. All of this is handled in one place —
> `src/lib/polymarket/normalize.ts`.

**Categories** come from `event.tags[]` (e.g. `Politics`, `Economy`, `Fed Rates`, `Crypto`). There is
no single canonical "category" field, so we map the tag set onto our own fixed category enum
(`src/lib/polymarket/categories.ts`) with a first-match-wins priority list.

### 1.2 Data API — `https://data-api.polymarket.com`

Public, unauthenticated, keyless. This is the smart-money core.

| Endpoint | Purpose | Verified fields |
| --- | --- | --- |
| `GET /positions?user=` | Open positions **already enriched with cost basis and PnL** | `proxyWallet, asset, conditionId, size, avgPrice, initialValue, currentValue, cashPnl, percentPnl, totalBought, realizedPnl, percentRealizedPnl, curPrice, redeemable, mergeable, title, slug, eventId, eventSlug, outcome, outcomeIndex, oppositeOutcome, endDate, negativeRisk` |
| `GET /closed-positions?user=` | Settled positions — the historical track record | `proxyWallet, asset, conditionId, avgPrice, totalBought, realizedPnl, curPrice, title, slug, eventSlug, outcome, outcomeIndex, endDate, timestamp` |
| `GET /activity?user=` | Full on-chain action log | `proxyWallet, timestamp, conditionId, type (TRADE\|SPLIT\|MERGE\|REDEEM\|REWARD\|CONVERSION), size, usdcSize, price, asset, side (BUY\|SELL), outcomeIndex, title, slug, eventSlug, outcome, name, pseudonym, bio, profileImage` |
| `GET /value?user=` | Portfolio value | `[{ user, value }]` |
| `GET /traded?user=` | Lifetime trade count | `{ user, traded }` |
| `GET /holders?market=<conditionId>` | Top holders per outcome token — our **trader discovery** mechanism | `token, holders[{ proxyWallet, name, pseudonym, amount, outcomeIndex, bio, profileImage, verified }]` |
| `GET /trades` | Global trade tape (optionally `?user=` / `?market=`) | same shape as activity `TRADE` rows |
| `GET /v1/leaderboard` | All-time PnL/volume ranking — our **seed discovery** source | `[{ rank, proxyWallet, userName, xUsername, verifiedBadge, vol, pnl, profileImage }]` |

Pagination is `limit` / `offset`, and the ceilings differ per endpoint — measured, not documented:
`/positions` 500, `/activity` 500, but **`/closed-positions` caps at 50**, so a long track record
takes many round trips.

`/activity` is also where we get a wallet's **public profile name** (`name`, `pseudonym`,
`profileImage`) — there is no separate profile endpoint we can rely on.

### 1.3 CLOB API — `https://clob.polymarket.com`

Public for reads. **We use read endpoints only. No order placement code exists in this repo.**

| Endpoint | Purpose | Response |
| --- | --- | --- |
| `GET /book?token_id=` | Full order book | `{ market, asset_id, timestamp, hash, bids[{price,size}], asks[{price,size}] }` |
| `GET /midpoint?token_id=` | Midpoint | `{ mid: "0.003" }` (string) |
| `GET /spread?token_id=` | Spread | `{ spread: "0.004" }` (string) |
| `GET /prices-history?market=<tokenId>&interval=&fidelity=` | Historical price series — **the backtest price oracle** | `{ history: [{ t: unixSeconds, p: number }] }` |

Note the naming trap: `prices-history` takes `market=<CLOB token id>`, **not** a condition id.

### 1.4 What we could NOT obtain reliably

Documented honestly, and rendered as `Unavailable` in the UI rather than guessed:

| Wanted | Status | What we do instead |
| --- | --- | --- |
| A *windowed* trader leaderboard (daily / weekly / monthly) | `GET data-api/v1/leaderboard` works, but its `window` parameter is inert — `1d`, `7d`, `30d` and `all` return byte-identical results, and it caps at ~50 unique wallets | We use it for all-time discovery only (`npm run db:seed -- --discover=120`), label the figures all-time in the trader notes, and supplement with `GET /holders` on high-volume markets plus manual wallet entry |
| A trader's historical *portfolio value* time series | No endpoint | We build our own by storing `TraderSnapshot` rows on every sync; history starts the day you add the trader |
| Per-position open timestamp on `/positions` | Not present | Derived from the earliest `TRADE` in `/activity` for that `conditionId` + `outcomeIndex` |
| True fee-adjusted realized PnL | `/positions` exposes `entryFeesUsdc` only | We surface `realizedPnl` as reported and label it as exchange-reported |
| Wallet clustering / correlated-wallet identity | Not exposed by any API | We approximate with a behavioural co-occurrence heuristic and label it explicitly as an approximation |
| Resolution-criteria ambiguity | Not a field | Heuristic text scan of `description` (`src/lib/scoring/clarity.ts`), always shown as a heuristic |

### 1.5 Field semantics that are not what the name suggests

These were found by reconciling live responses against each other, not by reading docs. Each one
silently corrupts financial output if taken at face value, so each has a regression test in
`src/lib/polymarket/normalize.test.ts`.

**`totalBought` counts SHARES, not dollars.** The name reads like a dollar amount and the value
sits next to `realizedPnl`, which is dollars. It is not. Verified across 50 live
`/closed-positions` rows: for a winning position, `realizedPnl == totalBought − totalBought ×
avgPrice`, which only balances if `totalBought` is a share count. The USD cost basis is therefore
`totalBought × avgPrice`, and the same relation holds on open positions where
`initialValue == size × avgPrice`.

Taken literally, every derived figure is inflated by `1/avgPrice` — at an average entry of 20¢
that is a 5× overstatement of capital staked and a correspondingly deflated ROI. We normalize to
an explicit `sharesBought` plus a derived `costBasisUsd` at the boundary so the ambiguous name
never reaches the internal model.

**`/closed-positions` is redemption-driven, so win rates are biased upward.** A position appears
there once its tokens are *redeemed*. Winning tokens are always redeemed because they are worth
money; worthless losing tokens are frequently abandoned, and those never appear. The result is
wallets with a literally perfect record — one tracked wallet reports 59 closed positions, 59 wins,
0 losses, and exactly 59 `REDEEM` activity rows.

We cannot repair the history, so we flag it: `TraderPerformance.redemptionBiasSuspected` is set
when a wallet has a meaningful sample and no losses at all, it costs the wallet a scoring penalty,
and the UI states plainly that the record is more likely incomplete than perfect. Separately,
`historyTruncated` marks wallets whose stored history hit the per-sync page cap, so their figures
are a recent subset rather than a lifetime record.

**`/markets?condition_ids=X` hides closed markets, and reports success while doing it.** The
endpoint applies an implicit open-markets filter. Ask it for a settled market by condition id and
it returns HTTP 200 with `[]` — indistinguishable from "no such market". Passing `closed=true`
returns the market normally, with `umaResolutionStatus: "resolved"` and `outcomePrices` settled to
`["1","0"]`.

This is the most damaging of the three, because a trader's settled record consists *entirely* of
closed markets. Before the fix, 24,777 of 27,389 settled positions had no linked market row, which
starved exactly the data the track record and the backtest are built on.
`fetchMarketsByConditionIds` therefore queries each batch twice: once as-is, then again with
`closed=true` for whatever the first pass did not return.

**`endDate` is the scheduled close, not the resolution time.** Gamma returns settled markets whose
`endDate` is still in the future — a "will X happen in September" market settles the moment X
happens but keeps its end-of-month end date. Using it directly places resolutions in the future,
which a backtest would then try to evaluate from a signal time that has not occurred. `resolvedAt`
is clamped to `min(endDate, now)` and treated as an upper bound on when resolution occurred, and
the backtest additionally skips any signal time that is not yet in the past.

---

## 2. System shape

```
                 ┌──────────────────────────────────────────┐
   Polymarket    │  Gamma        Data          CLOB         │
   (public,      │  events       positions     book         │
    read-only)   │  markets      closed-pos    midpoint     │
                 │  search       activity      spread       │
                 │               holders       prices-hist  │
                 └───────────────────┬──────────────────────┘
                                     │  rate-limited, retried, cached
                          ┌──────────▼───────────┐
                          │  src/lib/polymarket  │  external types + one HTTP core
                          │  http · gamma · data · clob · normalize
                          └──────────┬───────────┘
                                     │  normalized internal models (never raw API shapes)
                          ┌──────────▼───────────┐
                          │  src/lib/sync        │  npm run sync  ·  POST /api/cron/sync
                          └──────────┬───────────┘
                                     │
                          ┌──────────▼───────────┐
                          │  PostgreSQL (Prisma) │
                          └──────────┬───────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │  src/lib/scoring  (pure, tested)│
                    │  trader-score · behavior ·      │
                    │  consensus · opportunity ·      │
                    │  payout · entry-gap · clarity   │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │  Next.js App Router (RSC)       │
                    │  Opportunities · Smart Money ·  │
                    │  Traders · Activity · Backtest ·│
                    │  Settings                       │
                    └─────────────────────────────────┘
```

### Layer rules

1. **`src/lib/polymarket/types.ts` holds external API shapes only.** Every field there was observed in
   a real response. Nothing is invented. If Polymarket changes a field, this is the only file that lies.
2. **`normalize.ts` is the only bridge** between external shapes and our internal model. It parses the
   JSON-encoded string fields, coerces string numbers, and returns `null` for anything missing — never
   `0` as a stand-in for "unknown".
3. **`src/lib/scoring/*` is pure and synchronous.** No network, no Prisma, no `Date.now()` passed
   implicitly (the clock is always an argument). This is what makes it unit-testable and what makes
   the backtest able to re-run the *exact same code* on historical inputs.
4. **All numeric output passes through `safeNumber()`** (`src/lib/num.ts`) before reaching the UI.
   `NaN` and `Infinity` are converted to `null`, and `null` renders as `Unavailable`.

---

## 3. Rate limiting, caching, and not hammering the API

`src/lib/polymarket/http.ts` implements a single shared HTTP core used by all three clients:

- **Per-host token bucket.** Configured well under the published limits (Data API is ~1000 req/10s
  overall but ~150/10s for `/positions`). Defaults live in `POLYMARKET_RATE_LIMITS` and are
  env-overridable: Gamma 8 req/s, Data 6 req/s, CLOB 8 req/s.
- **Serialised queue per host** — concurrency capped (default 4) so a large watchlist sync degrades
  gracefully instead of bursting.
- **Retries with exponential backoff + jitter** on `429`, `5xx`, and network errors. `Retry-After` is
  honoured when present. Default 4 attempts, 500ms base, capped at 15s.
- **In-process TTL cache** keyed on the full URL. Market data 60s, order books 15s, closed positions
  10min, price history 1h. The cache is a plain `Map` with size-capped LRU eviction — deliberately not
  Redis, because this is a single-user local app.
- **Cursor pagination helper** `paginate()` that walks `limit`/`offset` until a short page comes back,
  with a hard page cap so a bad filter can't loop forever.

### Sync cadence

`npm run sync` runs all stages. Individual stages: `--only=markets|traders|scores|opportunities`.

| Stage | Default cadence | What it does |
| --- | --- | --- |
| `markets` | 10 min | Pull active events + nested markets, upsert `Market`, write a `MarketSnapshot` **only when price/liquidity moved past a threshold** |
| `traders` | 15 min | For each active tracked trader: `/positions`, `/closed-positions`, `/activity` (incremental via `start=` last seen), `/value`, `/traded` |
| `scores` | after `traders` | Recompute `TraderPerformance`, `TraderMarketPerformance`, behaviour classification, Smart Trader Score |
| `opportunities` | after both | Recompute consensus + opportunity scores, emit `Signal` rows and activity-feed events |

Snapshots are deduplicated: a new `MarketSnapshot` is only written when price moves ≥ 0.5¢, liquidity
moves ≥ 5%, or 6h have elapsed. Same idea for `PositionSnapshot` (≥ 2% size change or 6h).

For deployments, `POST /api/cron/sync` does the same work, guarded by a `CRON_SECRET` bearer token,
compatible with Vercel Cron / GitHub Actions.

---

## 4. Scoring philosophy

Three transparent 0–100 scores, all computed from measurable inputs, all showing their components and
penalties in the UI. **No LLM produces a number anywhere in this application.**

1. **Smart Trader Score** — how good is this wallet? (`src/lib/scoring/trader-score.ts`)
2. **Smart Money Consensus** — how strong is the agreement on this market side?
   (`src/lib/scoring/consensus.ts`)
3. **Opportunity Score** — is this still a good trade *at today's price*?
   (`src/lib/scoring/opportunity.ts`)

Every weight, threshold and penalty lives in **one file**: `src/lib/scoring/config.ts`, overridable via
`AppSettings` in the database and editable from the Settings page.

The load-bearing idea of the whole product is the **entry gap**:

```
entryGap = currentPrice − weightedSmartMoneyEntryPrice
```

A brilliant trader who bought YES at 21¢ tells you very little when the price is 68¢, because you would
be entering a materially different trade. The Opportunity Score applies a graduated penalty as the gap
widens, and the UI shows the gap on every card and every row.

---

## 5. Backtesting and look-ahead bias

See `IMPLEMENTATION_PLAN.md` §Phase 5 and the on-page methodology panel. Summary of the four rules
enforced in `src/lib/backtest/`:

1. **Point-in-time market state only.** Prices come from `MarketSnapshot` rows (or CLOB
   `prices-history` samples) with `capturedAt <= signalTime`. Never from the current `Market` row.
2. **Point-in-time trader quality.** A trader's score at the signal timestamp is recomputed using only
   positions that **resolved before** that timestamp. A wallet that got famous in March is not treated
   as elite in January.
3. **Resolution is the only future data used**, and only as the label — never as a feature.
4. **Minimum settlement lag.** A signal is only scored once its market has actually resolved; unresolved
   markets are excluded from win-rate and ROI rather than marked as wins.

The backtest calls the *same* `scoreOpportunity()` function the live page calls, with a point-in-time
input bundle. There is no separate "historical" scoring implementation that could drift.

### 5.1 Two biases that are not look-ahead, and are more dangerous for it

Look-ahead is the bias everyone checks for. These two passed every look-ahead rule above and still
produced a large fake edge.

**Stale benchmark prices** (`src/lib/sync/prices.ts`). Rule 1 requires the price be observed at or
before the signal — it says nothing about *how long* before. The price was previously allowed to
come from the last tracked fill at any age, which in practice meant days or weeks. That is not a
neutral approximation: prices drift toward the eventual outcome, so a stale price is systematically
too low on markets heading for YES. It is both the benchmark the win rate is compared against and
the denominator of the `1/p` payout, so the error lands on precisely the trades that won. Measured
effect: return per dollar fell from +1.7% to −4.3% once benchmarks older than 24h were rejected.
Fixed by backfilling real CLOB curves into `MarketPriceSeries` and adding `maxPriceAgeHours`.
`BacktestResults.priceQuality` reports the source mix and the age distribution every run.

**Configuration search** (`src/lib/backtest/robustness.ts`). Running the analysis at six horizons
and reporting the best one is a multiple comparison that no single run can see. The per-run
permutation test in `stats.ts` corrects for comparing six score *bands*, and correctly reported
p=0.009 for the winning band — but that p-value is conditional on the horizon, which had itself
been chosen by searching. `runRobustnessSweep` runs the whole grid and requires a band to hold
across a majority of usable horizons before calling anything replicated. Note that horizons are
*not* independent samples: they replay overlapping markets and largely the same trades, so two
agreeing horizons are worth considerably less than two independent experiments, and the verdict
logic is deliberately conservative about this.

### 5.2 Significance testing

`src/lib/backtest/stats.ts`. The null hypothesis is the one that matters — *the score adds nothing
beyond the price* — so each iteration redraws every outcome as `Bernoulli(priceAtSignal)` rather
than shuffling the observed outcomes. A naive shuffle would destroy the true relationship between
price and outcome and would then manufacture a large "edge" for any band that happened to contain
cheap longshots. Comparing the observed statistic against the *maximum* band edge under that null
pays for the six-band comparison without a separate correction. Win rates carry Wilson intervals,
which unlike the normal approximation stay inside [0,1] at the small samples these bands produce.

---

## 6. Security and safety posture

- No wallet connection. No `window.ethereum`. No signing library in `package.json`.
- No CLOB write endpoints. `src/lib/polymarket/clob.ts` exports read functions only and the module has
  a comment banning order placement.
- No private key, seed phrase, or password input anywhere in the UI.
- The only secret in `.env` is `CRON_SECRET` (protects the sync route) and `DATABASE_URL`.
- All API routes that mutate (`traders`, `settings`) are local-first and validated with `zod`.
- Ethereum addresses are validated (`/^0x[a-fA-F0-9]{40}$/`) and normalised to lowercase before storage.

---

## 7. Deliberate non-goals for V1

Documented so they don't look like oversights:

- No websockets / real-time streaming. Polling + caching is sufficient for a research tool and much
  simpler to operate.
- No Redis, no job queue, no worker process. A single `sync` entry point invoked by cron is enough.
- No multi-user auth. This is a single-user local dashboard.
- No LLM-generated probabilities. The `MODEL ESTIMATE` is derived quantitatively from smart-money
  signals and is always displayed as a **range** with an explicit uncertainty caveat.
