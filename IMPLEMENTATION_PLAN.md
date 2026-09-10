# PolyAlpha — Implementation Plan

Phased build plan with the current state marked. Companion docs: `ARCHITECTURE.md` (system shape
and API findings), `DATA_MODEL.md` (schema and normalization).

**Status legend:** ✅ done · 🔄 in progress · ⬜ not started

---

## Standing constraints

These are not phase items. They apply to every commit.

**No trading, ever.** No wallet connection, no private key or seed phrase prompt, no order
creation, no transaction signing, no auto-copy. `src/lib/polymarket/clob.ts` contains read
endpoints only and says so at the top of the file. The only action affordance anywhere in the UI
is **View on Polymarket**, which opens the market in a new tab. The payout calculator's `ALL`
button computes a number and nothing else.

**No invented API fields.** Every external type in `src/lib/polymarket/types.ts` corresponds to a
field observed in a real response. Anything we cannot obtain reliably renders as **Unavailable**
rather than being estimated, defaulted to zero, or quietly omitted.

**No NaN or Infinity in the UI.** `safeNumber` returns `null` rather than `0` for unparseable
input, financial helpers check their *results* for finiteness rather than only their arguments,
and the `Stat`/`KeyValue`/`TD` primitives render `null` as **Unavailable**.

**No hype.** Scores are presented with their full component breakdown and their penalties. The
model estimate is labelled a model estimate with an uncertainty range. "Guaranteed", "easy money",
"sure bet" and "can't lose" do not appear except inside disclaimers, and a test enforces this.

**After every phase:** `npm run typecheck`, `npm run lint`, `npm test`. Fix before continuing.

---

## Phase 0 — API research ✅

Verify every endpoint against live responses before writing an integration. Documented in
`ARCHITECTURE.md` §1.

- ✅ Gamma, Data and CLOB endpoints probed live; response shapes captured in `.research/`
- ✅ Page-size ceilings measured, not assumed: `/positions` 500, `/activity` 500,
  **`/closed-positions` 50**
- ✅ JSON-encoded-string fields identified (`outcomes`, `outcomePrices`, `clobTokenIds`)
- ✅ `prices-history` confirmed to take a **CLOB token id**, not a condition id
- ✅ `/v1/leaderboard` confirmed working; its `window` parameter proven inert and its result set
  capped at ~50 wallets
- ✅ **`totalBought` proven to be a share count, not dollars** — the single most consequential
  finding, since taking it literally inflates staked capital by `1/avgPrice`
- ✅ **Redemption bias identified** in `/closed-positions`: unredeemed losers never appear, which
  manufactures perfect win rates
- ✅ Unobtainable data enumerated with the fallback for each

## Phase 1 — Foundation ✅

- ✅ Next.js 15 + TypeScript (strict) + Tailwind skeleton
- ✅ Prisma schema (`DATA_MODEL.md`)
- ✅ Local Postgres with **zero install** — `npm run db:local` runs real PostgreSQL 18 binaries
  shipped as an npm package (`scripts/db-local.ts`), so no Docker, no system install and no admin
  rights are needed. Point `DATABASE_URL` at an existing server instead and nothing else changes.
  This replaced an earlier PGlite-based setup that could not survive sync-sized write volume; the
  cluster is forced to `--encoding=UTF8 --locale=C` because `initdb` otherwise inherits the host
  Windows locale and produces a WIN1252 cluster that rejects the arrows and accents which appear
  routinely in Polymarket market questions.
- ✅ API clients with one shared HTTP core (`http.ts`): token-bucket rate limiting, bounded
  concurrency, exponential backoff with full jitter, `Retry-After` honoring, TTL cache, pagination
- ✅ Normalization layer, the only bridge between external and internal shapes
- ✅ Watchlist seeded with **real** leaderboard wallets; `--discover=N` widens it
- ✅ Sync orchestration with per-stage `SyncRun` rows
- ✅ End-to-end run against live data

## Phase 2 — Traders ✅

- ✅ Smart Trader Score with all seven weighted components and every penalty, weights in one
  configurable file (`src/lib/scoring/config.ts`)
- ✅ Behavior classification (discretionary / bot / scalper / market maker) with confidence and
  written reasons, never presented as certain
- ✅ Entry-price bucket analysis across the seven specified bands, so a wallet that only buys 98¢
  outcomes does not read as a great forecaster
- ✅ Per-category skill with Bayesian shrinkage
- ✅ Redemption-bias and truncation flags surfaced as score penalties
- ✅ **Traders list page** — sortable table, score, behavior badge, category, realized and
  unrealized in separate columns, winners-only and truncated flags
- ✅ **Trader profile page** — overview stats, realized vs unrealized kept visually distinct,
  score breakdown, behavior explanation, open and settled positions, warning banner when the
  record is redemption-biased or truncated
- ✅ **Performance charts** — cumulative realized PnL, monthly PnL, wins/losses, PnL and ROI by
  category, performance by entry-price bucket (`src/components/trader-charts.tsx`)
- ✅ **Add / edit trader** UI with Ethereum address validation (`/settings`)

## Phase 3 — Smart money and opportunities ✅

- ✅ Consensus scoring with per-wallet deduplication, correlation approximation, concentration
  penalty
- ✅ Entry-gap analysis (`current − weighted smart-money entry`) with good/poor/stale grading
- ✅ Opportunity Score with the specified weights and penalties
- ✅ Model estimate as a quantitative range from smart-money signals — never an LLM-guessed
  probability
- ✅ Eligibility gate so signal-less rows and untradeable prices stay off the list
- ✅ **Opportunities page** (the main page) — ranked cards with price, payout, consensus, entry
  gap, liquidity, spread, time to resolution, risk
- ✅ **"Why it is interesting" / "Why it could fail"** rendered on every opportunity
- ✅ **Smart Money page** — per-market YES/NO aggregation, tracked capital each side, recent flow
- ✅ **Home dashboard** — top opportunity, 24h activity, tracked traders, strong-consensus count

## Phase 4 — Interaction ✅

- ✅ **Payout calculator** — `$0.25 / $0.50 / $1 / $2 / ALL` quick stakes, shares, gross payout,
  profit, return %, break-even probability. `ALL` calculates and never orders — its tooltip says
  so. Payout labelled **maximum payout if the outcome wins**, with no implication that a bigger
  payout is better.
- ✅ **Small-bankroll mode** — default $7, editable. Shows the consequences of hypothetical
  amounts rather than recommending one, and warns visually as the share of bankroll grows.
- ✅ **Filters** — category, min trader score, min consensus, min liquidity, max spread, min
  agreeing traders, max entry gap, resolution window, exclude bots (**on by default**)
- ✅ **Activity feed page** — aggregated rather than a transaction dump
- ✅ **Settings page** — bankroll, filter defaults, watchlist management
- ✅ **API route** — `POST /api/cron/sync` guarded by `CRON_SECRET`, with a length-checked
  constant-time token comparison and a `GET` that reports liveness without ever starting a sync

## Phase 5 — Backtesting ✅

- ✅ Point-in-time state reconstruction: holdings replayed from the trade log, prices taken from
  the last observation at or before the signal time, **trader scores recomputed from scratch at
  each historical date**
- ✅ Historical signal replay through the *same* `computeConsensus` and `computeOpportunityScore`
  used live, with the clock injected — there is no parallel "historical" scoring implementation
  that could drift
- ✅ **Backtest page** — signal count, win rate against the market-implied rate, edge in
  percentage points, return per $1, rank correlation, max drawdown, results bucketed by score band,
  and a full accounting of what was skipped and why
- ✅ Look-ahead-bias documentation rendered **on the page**, enumerating each of the four possible
  leaks and how it is closed, plus the two limitations that cannot be engineered away
- ✅ Honesty guards: the run warns outright when higher scores did *not* lead to better outcomes,
  and when the score-to-outcome relationship is non-monotonic, so a positive-looking aggregate
  cannot be mistaken for a working score

## Phase 6 — Making the backtest trustworthy ✅

Phase 5 produced a result that looked like a discovery. Phase 6 established that it was not, and
built the machinery that catches this class of mistake automatically.

- ✅ **Wilson confidence intervals** on every win rate (`src/lib/backtest/stats.ts`). A band of 8
  signals reading "37.5%" actually spans 14%–69%; the interval is shown next to the point estimate
  everywhere, in the CLI and on the page
- ✅ **Parametric bootstrap significance test.** Each iteration redraws outcomes as
  `Bernoulli(priceAtSignal)`, so the null is "the score adds nothing beyond the price". Uses the
  max band edge as the statistic, which pays for comparing six bands without a separate correction
- ✅ **Robustness sweep** (`src/lib/backtest/robustness.ts`, `npm run backtest -- --sweep`). Runs
  the whole analysis at six horizons and returns one of five verdicts. Requires a band to hold
  across a *majority* of usable horizons before calling it replicated
- ✅ **Real historical prices** (`src/lib/sync/prices.ts`, `MarketPriceSeries`). CLOB
  `/prices-history` curves backfilled for every resolved market a tracked wallet touched, plus a
  `maxPriceAgeHours` limit and per-run reporting of price source and age
- ✅ **Outcome-independent trader discovery** (`src/lib/sync/discover.ts`) — see below

### What the backtest currently says

**It says the Opportunity Score does not work.** Getting to that answer took undoing two flattering
ones, both of which passed every look-ahead check.

**Flattering answer #1: searching six configurations.** A single run reported +12.8pp in the 20–40
band at p=0.009 — significant even after correcting for the six-band comparison. The same analysis
at neighbouring horizons gave p = 0.007, 0.130, 0.686, 0.142, 0.017, 0.565. An effect does not
appear at one day, vanish at two, three and five, and return at seven. The per-run test cannot see
this, because each run only sees itself; hence the sweep.

**Flattering answer #2: stale benchmark prices.** The look-ahead rules required the price be
observed *at or before* the signal but said nothing about how long before, so a fill from weeks
earlier could serve as "the market implied probability at T". Prices drift toward the eventual
outcome, so the error is not symmetric — it sits too low on markets heading for YES, which is both
the benchmark the win rate is judged against and the denominator of the `1/p` payout. It lands on
exactly the trades that won.

Effect of fixing it, same signals, 1-day horizon:

| | Before | After |
| --- | --- | --- |
| Signals surviving | 1,076 | 157 |
| Median benchmark age | days | **1.0h** (p90 18h) |
| Prices from a real CLOB quote | 0 | 144 of 157 |
| Aggregate edge | +1.6pp | +1.2pp |
| **Return per $1** | **+1.7%** | **−4.3%** |
| Best band significance | p=0.007 | p=0.295 |

What survives: no band beats its own prices by more than chance produces, the aggregate edge is
not significant (p=0.41), and rank correlation is ≈0 or slightly negative at every horizon. The
sweep verdict is `INCONSISTENT`.

The weights have deliberately not been adjusted to improve this. Tuning parameters until the
backtest looks good, on the data the backtest runs on, is how a fitted number gets mistaken for an
edge.

### Watchlist survivorship, partly addressed

The original 50 wallets all came from `/v1/leaderboard`, which ranks by all-time realised profit.
They were selected *because they won*, so replaying their trades and finding the trades did well
proves close to nothing.

`npm run sync -- --only=discover` samples the largest holders of the highest-volume markets
instead. Volume is a property of the market, not of the wallet's record, so the selection is
outcome-independent — a wallet that lost heavily is as likely to appear as one that won. First run
added 200 wallets from 150 markets (5,874 holder rows, 3,028 unique wallets, filtered to those
appearing in ≥2 markets), taking the watchlist from 50 to 250.

Honest limit: `/holders` returns the *largest* holders, so the sample is still biased toward size.
That is much weaker than selecting on profit — being big does not imply having been right — but it
is not neutral sampling. `TraderSource` records which route each wallet arrived by.

---

## Testing

**244 tests passing.** Every financial calculation is covered, with deterministic fixtures and no
network access.

| Area | Covers |
| --- | --- |
| `num.test.ts` | safe arithmetic, division by zero, formatting, locale independence |
| `payout.test.ts` | shares, gross payout, profit, break-even, boundary prices 1¢/50¢/99¢, $0 stake, extreme stakes |
| `entry-gap.test.ts` | gap sign and grading, missing entry data, better-than-elite entries |
| `trader-score.test.ts` | every component and penalty, tiny samples, single positions, redemption bias |
| `consensus.test.ts` | wallet dedupe, one-wallet dominance, concentration, zero traders |
| `opportunity.test.ts` | weight redistribution, penalty scaling, no-hype language check |
| `normalize.test.ts` | JSON-string parsing, cost-basis units, three-valued `won`, wallet validation |
| `categories.test.ts` | real tag sets, weighted scoring, tie-breaks, fallbacks |
| `backtest/engine.test.ts` | each look-ahead leak, sell-side cost-basis accounting, Spearman edge cases, the "high win rate on favourites is not an edge" case, non-monotonicity detection, binary search never returning a future price sample, stale-benchmark warnings |
| `backtest/stats.test.ts` | Wilson intervals at n=0 and at both extremes, seeded RNG determinism, a calibrated dataset yielding no significance, a planted edge being detected, and the correctly-priced-longshot trap that a naive shuffle null would fail |
| `backtest/robustness.test.ts` | each verdict, two hits in *different* bands not counting as replication, 2-of-5 horizons reading as `INCONSISTENT` rather than replicated, no hype in any verdict |
| `sync/discover.test.ts` | markets selected by volume and never by trader performance, both sides of one market counting once, dust filtering, pseudonyms never used as display names, specialty left `UNKNOWN` on a tie |
| `opportunity-filters.test.ts` | query-string parsing rejecting values that are not real enum members before they reach a Prisma filter |

The backtest's anti-look-ahead guarantees are tested as behaviour, not asserted in a comment. The
sharpest of them: a wallet whose entire 40-win record postdates a signal scores **zero** at that
signal, and a wallet that lost money before the signal but won big afterwards scores below the
qualification bar at the signal — which is the exact contamination that makes leaky backtests look
brilliant.

Boundary cases are covered explicitly because they are where money bugs live: 1¢ and 99¢ prices,
zero stake, zero liquidity, one trader, no traders, missing market data, and stakes large enough
to overflow a float.

Two tests exist because a real bug reached them first. `calculatePayout(1e308, 1e-308)` returned
`Infinity` shares from two individually finite arguments, which is why the guard checks results
rather than inputs. And the naive no-hype check flagged our own disclaimer *"It is not a
guaranteed edge"* — the test now matches hype only in affirmative position, since disclaiming
those words is exactly the tone we want.

---

## Known data caveats

Surfaced in the UI, not hidden:

- Closed-position history is capped per sync, so long-history wallets are flagged
  `historyTruncated` and their figures cover a recent subset.
- Summed closed-position `realizedPnl` does not reconcile with the leaderboard's PnL figure. We
  report ours as computed from positions and do not silently substitute theirs.
- The leaderboard is all-time only, so "recent form" comes from our own snapshots and begins the
  day a trader is added.
- Correlated-wallet detection is a behavioural approximation. No API exposes wallet identity, and
  the UI says so wherever the penalty is applied.
- `resolvedAt` is an **upper bound**, not the settlement moment. Gamma's `endDate` is the scheduled
  close, and settled markets routinely carry an end date that has not arrived yet. It is clamped to
  `min(endDate, now)`, and the backtest additionally refuses any signal time that is not yet past.
- Market rows arrive after the trades that reference them, so `marketId` starts null on a lot of
  activity and settled positions. The `relink` sync stage reconnects them by `conditionId`; without
  it, everything joined by market — including the backtest's entire universe — silently sees a
  fraction of the data. On the first run after the closed-market fetch fix it reconnected 84,033
  activity rows and 14,040 settled positions.
- Backtest coverage is bounded by how far back tracked-trader trade history reaches, and by the
  price observations available at each signal time. Markets with no observable price are skipped
  and counted rather than estimated.
