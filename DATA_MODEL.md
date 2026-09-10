# PolyAlpha — Data Model

How Polymarket's API responses become the internal model the application actually reasons about.

The governing rule: **external API shapes and internal database models are separate types, and
nothing crosses between them except through `src/lib/polymarket/normalize.ts`.** External shapes
live in `src/lib/polymarket/types.ts` and mirror exactly what the wire returns, including the
awkward parts. Internal models live in `prisma/schema.prisma` and are shaped for how we query.
When Polymarket changes a field, one file changes.

---

## 1. The boundary

```
  Polymarket JSON            normalize.ts              Prisma model
  ───────────────            ────────────              ────────────
  outcomes: "[\"Yes\",…]" →  parseJsonArray()       →  outcomes String[]
  liquidity: "12345.6"    →  safeNumber()           →  liquidity Float?
  timestamp: 1782948821    →  parseUnixSeconds()     →  resolvedAt DateTime?
  totalBought: 149999.88   →  sharesBought           →  sharesBought Float?
                           →  × avgPrice             →  costBasisUsd Float?
  proxyWallet: "0xAbC…"    →  normalizeWallet()      →  wallet String @unique (lowercase)
```

Four traps handled at this boundary, each with a regression test:

**JSON-encoded strings.** `outcomes`, `outcomePrices` and `clobTokenIds` arrive as *strings
containing JSON*, not arrays: `"[\"Yes\", \"No\"]"`. `JSON.parse` on a value that is sometimes
already an array and sometimes a malformed string is a crash waiting to happen, so
`parseJsonArray` accepts both and returns `[]` rather than throwing.

**Numeric twins.** `liquidity` and `volume` are strings; `liquidityNum` and `volumeNum` are the
same values as numbers, but are not always present. We read the string form through `safeNumber`
so there is one code path.

**Unit ambiguity.** `totalBought` is a share count despite the name (see `ARCHITECTURE.md` §1.5).
We never store it under a name that could be read as dollars: it becomes `sharesBought`, and the
dollar figure becomes a separately derived `costBasisUsd`.

**Case-sensitive identity.** The same wallet appears as `0xAbC…` and `0xabc…` across endpoints.
Every wallet is lowercased on the way in, so a trader cannot be tracked twice.

### Values we refuse to invent

`safeNumber` returns `null`, never `0`, for anything unparseable. This matters: a portfolio value
of `null` means "we could not obtain this" and renders as **Unavailable**, while `0` would mean
"this wallet is empty". Nullability in the schema is a deliberate signal, not laziness, and
`Number.isFinite` guards sit on every derived figure so `NaN` and `Infinity` cannot reach the UI.

---

## 2. Entities

Grouped by what they are for. Every model carries timestamps; indexes are listed only where they
exist for a specific query the app makes.

### 2.1 The watchlist

**`Trader`** — a wallet we track. `wallet` is unique and lowercase. `displayName`, `profileName`,
`profileUrl`, `specialty`, `notes` and `active` are all user-editable; `source` records whether
the row came from the seed list, leaderboard discovery, or manual entry. Deactivating a trader
keeps their history but drops them out of scoring.

`specialty` starts as `UNKNOWN` for every seeded trader by design. A wallet's real specialty is
something we *measure* from resolved positions, not something to assert up front.

**`TraderSnapshot`** — portfolio value and PnL at a point in time. Polymarket exposes no
historical portfolio series, so we build one: one row per sync, which means history starts the day
you add the trader. Indexed on `(traderId, capturedAt)`.

### 2.2 Positions and history

**`Position`** — a currently open position. Carries `size` (shares), `avgPrice`, `initialValue`
(USD cost basis), `currentValue`, `cashPnl`, `percentPnl`, and `sharesBought`. `openedAt` is
*derived*, not reported: it comes from the earliest `TRADE` in `/activity` for that
`(conditionId, outcomeIndex)`.

**`ClosedPosition`** — a settled position, and the basis of the entire track record. Holds
`avgPrice`, `sharesBought`, the derived `costBasisUsd`, `realizedPnl`, and `won`.

`won` is deliberately three-valued. `true`/`false` come from a clean settlement; anything
ambiguous stays `null` and is excluded from win-rate maths rather than guessed into a bucket.

**`PositionSnapshot`** — a position's value over time, written only when something moved. A
snapshot is stored when price moves ≥0.5¢, value moves ≥5%, or six hours pass. Without that
threshold every sync would write a near-duplicate row for every position.

**`TradeActivity`** — the on-chain action log: `TRADE`, `SPLIT`, `MERGE`, `REDEEM`, `REWARD`,
`CONVERSION`. Deduplicated on `(traderId, txHash, conditionId, outcomeIndex, timestamp)` because
`/activity` re-serves overlapping windows across pages. Indexed on `(marketId, occurredAt)` and
`(traderId, timestamp)`, which are the two ways the app reads it.

### 2.3 Markets

**`Market`** — one tradeable market, keyed by `conditionId`. Stores the parsed `outcomes`,
`clobTokenIds`, current `outcomePrices`, plus `liquidity`, `volume`, `spread`, `endDate`,
`closed`, `resolved`, `acceptingOrders`, `category`, `tags`, and the clarity heuristic output.

`category` is derived by weighted tag scoring (`src/lib/polymarket/categories.ts`), not
first-match-wins. Polymarket tags a Fed-rates market with both `economic-policy` and `politics`;
first-match ordering filed every FOMC market under Politics, and a politically-themed memecoin
market under Politics rather than Crypto. Specific tags score 3, generic ones score 1, and ties
break away from Politics because it is the most over-applied tag on the platform.

**`MarketSnapshot`** — price, liquidity and spread over time, under the same
write-only-on-change rule as `PositionSnapshot`. This is the series the backtest replays.

### 2.4 Derived analytics

Everything below is recomputed from scratch each sync. Nothing here is a source of truth; all of
it can be rebuilt from the raw tables above, which is what makes backtesting honest.

**`TraderPerformance`** — one row per trader. Realized and unrealized PnL are stored as separate
columns and never silently summed, because open-position gains are not profit. Alongside the
headline `smartScore` it stores `components` and `penalties` as JSON so the UI can show every
input to the number rather than the number alone.

Also carries the two honesty flags: `redemptionBiasSuspected` (the record appears to contain only
redeemed winners) and `historyTruncated` (the stored history hit the page cap, so figures cover a
recent subset).

**`TraderCategoryPerformance`** — per-trader, per-category record. Named for what it holds; the
original spec called it `TraderMarketPerformance`, but it aggregates by category, not by market.
`skillScore` uses Bayesian shrinkage toward the trader's overall record, so three lucky wins in
Crypto do not make someone a crypto expert.

**`MarketConsensus`** — the aggregate smart-money picture for one `(market, outcome)` side:
holder count, weighted quality, tracked capital, recent net flow, and the weighted average entry
price. Written for *every* side we can compute, whether or not it is rankable.

**`Opportunity`** — a ranked, listed opportunity for one side. Holds `score`, `rank`, the full
`components`/`penalties` breakdown, `currentPrice`, `weightedEliteEntry`, `entryGap`, the
three-point model estimate (`modelEstimateLow`/`Mid`/`High`), and the `reasonsFor`/`reasonsAgainst`
prose.

`Opportunity` rows are a strict subset of `MarketConsensus` rows. Consensus records what tracked
traders hold; an opportunity additionally has to *be* one — at least one qualified trader, at a
price between 2¢ and 98¢. Without that gate the list fills with thousands of signal-less rows and
sub-penny lottery tickets that outrank real signals on liquidity alone. The gate is in
`config.eligibility`; the softer user-facing filters are applied on read so they stay adjustable
without a resync.

**`Signal`** — the badges (`STRONG_CONSENSUS`, `RECENT_ACCUMULATION`, `CHASING`,
`ONE_WALLET_SIGNAL`, `LOW_LIQUIDITY`, …) with a `tone` so warnings render differently from
positives. Regenerated wholesale each pass rather than diffed.

**`FeedEvent`** — the activity feed, deliberately *not* a transaction dump. Events are aggregated
and deduplicated on `dedupeKey`, which embeds a day or hour bucket so one position being built
over an afternoon produces one event rather than forty.

### 2.5 Backtesting and operations

**`BacktestRun`** / **`BacktestSignal`** — a stored run plus every signal it generated, with the
entry price at signal time and the eventual outcome. Kept as rows rather than recomputed on demand
so a run's results stay reproducible after scoring weights change.

**`AppSettings`** — single row, id `default`. Bankroll, filter defaults, `excludeBots`, and any
scoring-weight overrides as JSON merged over `DEFAULT_SCORING_CONFIG`.

**`SyncRun`** — one row per stage per run, with duration, stats and error. Failures are visible in
the UI rather than silent.

---

## 3. Enums

`Category` — `POLITICS`, `ECONOMICS`, `SPORTS`, `CRYPTO`, `ENTERTAINMENT`, `GEOPOLITICS`, `OTHER`,
`UNKNOWN`. `OTHER` and `UNKNOWN` are distinct: `OTHER` means tags existed but matched nothing,
`UNKNOWN` means there was nothing to classify.

`BehaviorClass` — `DISCRETIONARY`, `POSSIBLE_BOT`, `SCALPER`, `MARKET_MAKER`, `UNKNOWN`. Stored
with `behaviorConfidence` and `behaviorReasons` because the classification is a heuristic and the
UI must never present it as certain.

`TraderSource` — `SEED`, `LEADERBOARD`, `MANUAL`, `HOLDERS`.

`ActivityType` — `TRADE`, `SPLIT`, `MERGE`, `REDEEM`, `REWARD`, `CONVERSION`.

`TradeSide` — `BUY`, `SELL`.

`SignalType` (12) / `SignalTone` / `FeedEventType`.

---

## 4. Point-in-time reconstruction

The backtest asks: *if this scoring algorithm had existed historically, would its top-ranked
signals have outperformed?* That question is only meaningful if the historical inputs contain
nothing the algorithm could not have known at the time.

Three properties of the model make that structurally enforceable rather than a matter of
discipline:

1. **Scoring functions are pure and take the clock as an argument.** `computeOpportunityScore(market, consensus, asOf, config)`
   has no ambient `Date.now()`. The backtest calls the same function the live sync calls, with a
   historical `asOf`, so there is no separate replay implementation to drift.

2. **Snapshots are append-only.** `MarketSnapshot`, `PositionSnapshot` and `TraderSnapshot` are
   never updated, so reconstructing state at time *T* is a filter on `capturedAt <= T`, not a
   reversal of mutations.

3. **The price oracle refuses to look forward.** `priceAt()` in `src/lib/polymarket/clob.ts`
   returns the last observation *at or before* the requested timestamp, or `null`. It cannot
   interpolate from a later point, so the common leak — pricing a historical signal with a price
   that had not happened yet — is impossible by construction rather than by convention.

The derived tables in §2.4 are excluded from backtest inputs entirely. They describe the present,
and a signal from six months ago must not be scored using a trader's record as it looks today —
that record includes the outcome of the very trade being evaluated.
