# PolyAlpha

A read-only Polymarket research dashboard. It tracks wallets with strong historical records,
measures how good those records actually are, finds markets where several of them agree, and ranks
what is left by whether the trade still looks worth making **at today's price**.

## What it does not do

This is the product's defining constraint, not a footnote:

- It never places, sizes, signs or creates an order.
- It never connects a wallet and never asks for a private key, seed phrase or password.
- It has no Polymarket account and no trading credentials of any kind.
- There is no auto-copy feature and no path to one.

Every market links out with a **View on Polymarket** button. You make the decision and you place
the trade yourself. The payout calculator's `ALL` button computes what a stake would buy — that is
all it does.

## Running it locally

Requires Node 20 or newer. Nothing else — no Docker, no PostgreSQL install, no admin rights.

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm run db:local            # leave this running in its own terminal
```

`npm run db:local` starts a real PostgreSQL server from the `embedded-postgres` npm package,
storing its cluster in `.pgdata/`. The first start initialises the cluster and takes a few seconds;
later starts are immediate. Then, in a second terminal:

```bash
npm run setup               # prisma generate + db push + seed the watchlist
npm run sync                # fetch from Polymarket (first run takes several minutes)
npm run dev                 # http://localhost:3000
```

The first sync is slow because it pulls each tracked trader's full history. Later syncs skip
everything that has not changed.

### Keeping it up to date by itself

Once the first sync has finished, you never need to run one by hand again. In a third terminal:

```bash
npm run auto                # syncs every 10 minutes until you stop it
```

That covers both halves of "up to date". `npm run auto` refreshes the *data* from Polymarket on a
loop, and the pages refresh *themselves* in the browser every 45–60 seconds, so a tab left open
keeps showing current numbers. The in-page refresh re-reads the database only — it never contacts
Polymarket, so leaving a tab open costs nothing upstream. There is a pause control next to the
"Auto-updating" indicator if you would rather it held still while you read.

So the normal way to run everything is three terminals:

| Terminal | Command | Purpose |
| --- | --- | --- |
| 1 | `npm run db:local` | The database |
| 2 | `npm run auto` | Keeps the data fresh |
| 3 | `npm run dev` | The website |

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run auto` | **Keeps the data current by itself** — syncs on a loop until you stop it |
| `npm run auto -- --minutes=5` | Same, on a tighter interval |
| `npm run sync` | Default pass: markets, traders, relink, scores, opportunities |
| `npm run sync -- --only=all` | Every stage, including holder discovery and the price backfill |
| `npm run sync -- --only=opportunities` | Rescore from stored data without refetching |
| `npm run sync -- --only=prices` | Backfill real CLOB price curves. Slow once, fast after |
| `npm run sync -- --only=discover` | Widen the watchlist from the holders of busy markets |
| `npm run sync -- --markets=300 --traders=50` | Bound the work |
| `npm run backtest -- --sweep` | **Start here.** Same analysis at six horizons, with a verdict |
| `npm run backtest` | A single run, with confidence intervals and a significance test |
| `npm run backtest -- --horizon=14 --lookback=365` | Backtest with a different signal horizon |
| `npm run db:seed -- --discover=100` | Add more wallets from the leaderboard |
| `npm run db:studio` | Browse the database |
| `npm test` | Vitest — every financial calculation is covered |
| `npm run typecheck` / `npm run lint` | Static checks |

`POST /api/cron/sync` runs the same sync for a scheduler. It requires
`Authorization: Bearer $CRON_SECRET`. That token authorises the endpoint and nothing else; it is
not a Polymarket credential.

### Using a PostgreSQL you already have

Point `DATABASE_URL` at it and skip `npm run db:local`. Nothing else changes.

## How to read the numbers

**Realized and unrealized PnL are never mixed.** Only settled positions count toward a track
record. An open position that is currently up is a position, not a result.

**A high win rate is not skill.** Someone who only buys 96¢ favourites wins most of the time and
makes very little doing it. Every trader profile breaks performance down by entry-price bucket for
this reason, and the Smart Trader Score penalises a record made mostly of near-certainties.

**The entry price is most of the signal.** A great trader who bought at 30¢ tells you very little
about buying the same outcome at 72¢ — that is a different trade with a different payoff. The
`ENTRY GAP` on every opportunity is the difference between today's price and the tracked traders'
weighted entry, and a large gap is flagged as `POOR ENTRY / SIGNAL MAY BE STALE` rather than being
quietly folded into a score.

**The model estimate is an estimate.** It is a small, bounded, explicitly-capped shift away from
the market price in the direction the smart money leans. It is not a measured probability, it is
labelled as an estimate everywhere it appears, and it always carries a range.

**Scores are never opaque.** Every Smart Trader Score, Consensus Score and Opportunity Score shows
each weighted component and each applied penalty. The weights all live in one file,
`src/lib/scoring/config.ts`.

**Missing data reads as "Unavailable".** Never as zero, never as a dash, never invented. No `NaN`
or `Infinity` reaches the interface.

## Dividing up an amount (`/plan`)

Enter a sum and the Plan screen splits it across the current list, respecting Polymarket's $1
order minimum. It is a **splitter, not an optimiser**, and the distinction is the whole point.

The usual way to size a position is the Kelly criterion, which scales a stake to your edge and
returns zero when there is no edge. The backtest below could not demonstrate an edge, so there is
no defensible "optimal" amount to compute — a tool that produced one would be inventing the number
it optimised against. What the screen does instead is take an amount you have already decided on
and divide it so no single outcome can do outsized damage.

Even weighting is the default because when you cannot rank candidates reliably, equal weighting is
the allocation that assumes least. Score weighting is available and carries a warning wherever it
is used.

Three things it always shows, because the headline figure is misleading on its own:

- **Expected back**, at the market's own prices. It comes out equal to what you put in, and not by
  coincidence: a share costing *p* pays $1 with probability *p*, so every basket bought at market
  breaks even on paper. Beating that requires the prices to be wrong.
- **The market-implied chance** of the best and worst cases, so "$7 becomes $86 if all five win"
  sits next to how likely that is.
- **A longshot warning** when the typical position is under 15¢. Large "if it wins" figures are
  the reason those prices are low, not a sign of value.

The $1 minimum is a real constraint, not a rounding detail: $7 can occupy at most 7 positions, and
positions whose share falls below $1 are dropped and their money redistributed rather than being
rounded up past the bankroll. Leftover money is reported, never quietly absorbed.

## What the backtest currently says

It says the Opportunity Score does not work. That answer is on the `/backtest` screen rather than
tuned away, and it is worth understanding how it was arrived at, because two earlier versions of
the same analysis said something much more flattering.

**The first flattering answer came from looking six times.** A single run reported a +12.8pp edge
in the 20–40 score band at p=0.009 — significant even after correcting for comparing six bands.
Re-running the identical analysis at neighbouring signal horizons gave 0.007, 0.130, 0.686, 0.142,
0.017 and 0.565. An effect does not appear at one day, vanish at two, three and five, and return
at seven. `npm run backtest -- --sweep` now runs all six and returns a verdict, because a single
run structurally cannot detect this about itself.

**The second came from stale prices.** The backtest measures its win rate against the market's
implied probability at the signal moment, so that price has to come from near that moment. It was
previously allowed to come from the last tracked fill at *any* age — sometimes weeks earlier.
Prices drift toward the eventual outcome, so an old price sits too low on markets heading for YES,
which inflates both the measured edge and the `1/p` payout on exactly the trades that won. After
backfilling real CLOB curves and rejecting benchmarks older than 24 hours, return per dollar went
from **+1.7% to −4.3%** on the same signals. The earlier number was mostly the bias.

**The third problem was that the sample was tiny, and two bugs were hiding it.** The sweep came
back `TOO LITTLE DATA` — no horizon reached 100 signals. The cause was not a shortage of markets
but two stages disagreeing about which markets mattered:

- *The backfill and the backtest selected opposite ends of the year.* Both filtered for resolved
  markets that tracked traders had touched, but the backtest ordered them `resolvedAt asc` and the
  price backfill ordered them `desc`. With ~19,500 markets in the window and a cap of 1,500 each,
  the two slices overlapped by **7 markets**. Every benchmark price fell back to a stale trade
  fill — precisely the failure the backfill existed to prevent. There is now one selector, in
  `src/lib/backtest/market-selection.ts`, used by both.
- *Thousands of resolution timestamps were fabricated.* `Market.resolvedAt` is derived from
  Gamma's `endDate`, which is the *scheduled* close, not settlement — and markets often resolve
  early, leaving a resolved market whose end date has not arrived. That case was being handled by
  clamping the timestamp to `NOW()`, which stamped "whenever a sync happened to run" onto **5,026
  markets** as their resolution time. Since the backtest derives its signal moment as
  `resolvedAt − horizon`, a stamp that late can place the "prediction" after the outcome was
  already known. Those timestamps are now recovered from observed settlement in
  `ClosedPosition.resolvedAt` where possible (2,213 markets) and set to unavailable otherwise.

What survives all that is: no score band beats its own prices by more than chance produces, the
aggregate edge is not significant, and the rank correlation between score and outcome is
approximately zero or slightly negative at every horizon tested. The score does not currently
identify mispriced outcomes, and the interface says so.

The weights have deliberately not been adjusted to improve this. Tuning parameters until the
backtest looks good, on the same data the backtest runs on, is how a fitted number gets mistaken
for an edge.

## Two data caveats worth knowing about

Both come from verified behaviour of Polymarket's public API, and both are surfaced in the UI
rather than hidden.

**Redemption bias.** `/closed-positions` is driven by redemptions. A losing outcome token is
worthless, so traders often never bother redeeming it — and it therefore never becomes a closed
position. Wallets that only redeem winners show flawless records. One leaderboard wallet returned
59 closed positions, 59 wins and 0 losses. Any trader whose settled record contains no losses at
all is flagged and score-penalised rather than celebrated.

**Truncated history.** `/closed-positions` pages out at 50 items, so a deep history is capped.
Affected traders are flagged as `TRUNCATED`, because their totals are lower bounds.

**Watchlist survivorship.** The original 50 wallets all came from `/v1/leaderboard`, which ranks
by all-time realised profit — so they were chosen *because they won*. Replaying their trades and
finding the trades did well would prove very little. `npm run sync -- --only=discover` widens the
list by sampling the largest holders of the highest-volume markets instead; volume is a property
of the market, not of the wallet's record, so that selection is outcome-independent. It is still
biased toward large wallets rather than good ones, which is a much weaker bias but not none. Each
trader records which route it arrived by.

See `DATA_MODEL.md` §1.5 for the full list, including two upstream field names that mean something
other than what they say.

## Documentation

| File | Contents |
| --- | --- |
| `ARCHITECTURE.md` | Verified API behaviour, layering, rate limiting, sync design |
| `DATA_MODEL.md` | Normalization boundary, every entity, point-in-time reconstruction |
| `IMPLEMENTATION_PLAN.md` | Phases, status, testing coverage, known caveats |

## Layout

```
prisma/schema.prisma          Database schema; seed.ts discovers wallets from the leaderboard
scripts/                      db-local.ts (PostgreSQL), sync.ts, backtest.ts
src/lib/polymarket/           API clients. types.ts mirrors the wire format exactly;
                              normalize.ts converts it into our own model. Nothing downstream
                              of normalize.ts ever sees an upstream field name.
src/lib/scoring/              Pure scoring functions. The clock is always an argument, which is
                              what lets the backtest replay them at a past date.
                              config.ts holds every weight and threshold.
src/lib/backtest/engine.ts    Point-in-time replay. The header documents each look-ahead leak
                              and how it is closed.
src/lib/sync/                 Fetch, normalize, diff, write. Skips unchanged rows.
src/lib/queries/              Read models for the pages.
src/lib/allocation.ts         Splits a chosen sum across opportunities under the $1 order
                              minimum. A splitter, not an optimiser — the header says why.
src/app/                      Next.js App Router: opportunities, plan, smart-money, traders,
                              activity, backtest, settings.
src/components/               UI. primitives.tsx is the single source of "Unavailable" rendering.
```

## Testing

`npm test` covers the financial calculations, including the boundaries that tend to break them:
prices at 1¢, 50¢ and 99¢, a $0 stake, zero liquidity, a single trader, no traders, missing market
data, and extreme position sizes. The backtest's look-ahead protections are tested directly — for
instance, that a wallet whose entire winning record postdates a signal scores zero at that signal.
