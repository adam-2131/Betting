/**
 * CASH SOON — what pays out in the next few days.
 *
 * The Opportunities screen ranks by signal quality and is horizon-blind by design. This one ranks
 * the same rows by return per day of capital tied up, priced at the ask rather than the mid.
 *
 * The two orderings disagree constantly, which is the reason both exist. A twelve-point edge that
 * settles in eight months earns about 0.05% a day; a four-point edge that settles on Sunday earns
 * 4%. Neither ranking is wrong — they are answers to different questions, and this page is the
 * answer to "what should I put money into now".
 */
import Link from "next/link";
import {
  CASH_SOON_SORTS,
  getShortTermStats,
  listCashSoon,
  readHorizon,
  readSports,
  type CashSoonSort,
} from "@/lib/queries/short-term";
import { getSettings } from "@/lib/settings";
import { formatPercent, intPlain } from "@/lib/num";
import { Card, EmptyState, SectionTitle, Stat } from "@/components/ui/primitives";
import { CashSoonCard } from "@/components/cash-soon-card";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  DEFAULT_SETTLEMENT_WINDOW,
  parseCategories,
  SETTLEMENT_WINDOWS,
  settlementHours,
} from "../filter-params";
import { CashSoonFilterBar } from "./filters";

export const dynamic = "force-dynamic";

/** Query strings are user-editable, so anything unrecognised falls back to the default ordering. */
function parseCashSoonSort(value: string | undefined): CashSoonSort {
  return CASH_SOON_SORTS.some((s) => s.value === value) ? (value as CashSoonSort) : "perDay";
}

export default async function CashSoonPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; window?: string; all?: string; sort?: string }>;
}) {
  const query = await searchParams;
  const categories = parseCategories(query.category);
  const windowValue = query.window ?? DEFAULT_SETTLEMENT_WINDOW;
  const withinHours = settlementHours(windowValue);
  // Opt-in view of the rows whose edge the spread already ate, so the filter stays inspectable.
  const showNegativeEdge = query.all === "1";
  const sort = parseCashSoonSort(query.sort);

  const [settings, stats, result] = await Promise.all([
    getSettings(),
    getShortTermStats(),
    listCashSoon({
      withinHours,
      categories: categories.length > 0 ? categories : undefined,
      requirePositiveEdge: !showNegativeEdge,
      sort,
      limit: 40,
    }),
  ]);

  const windowLabel =
    SETTLEMENT_WINDOWS.find((w) => w.value === windowValue)?.label.toLowerCase() ?? "this window";

  return (
    <div className="space-y-5">
      <Card>
        <h1 className="text-sm font-medium text-fg">Cash soon</h1>
        <p className="mt-1 max-w-prose text-2xs leading-5 text-muted">
          Ranked by expected return per <em>day</em> of capital tied up, not by signal strength. The
          entry price shown is what a buyer actually pays — the ask plus a slippage allowance — because
          over a few days the spread is often the entire trade. Every figure inherits the model
          estimate&rsquo;s caveat: it is a bounded nudge away from the market price in the direction
          smart money is leaning, not a measured probability, and a high score is not a claim that
          money will be made.
        </p>
      </Card>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <Stat
            label="Best return / day"
            value={
              stats.bestReturnPerDay === null ? "Unavailable" : formatPercent(stats.bestReturnPerDay, 2)
            }
            sublabel="within 7 days, after the spread"
            tone={stats.bestReturnPerDay && stats.bestReturnPerDay > 0 ? "positive" : "neutral"}
          />
        </Card>
        <Card>
          <Stat
            label="Settling today"
            value={intPlain(stats.settlingToday)}
            sublabel="scored sides within 24h"
          />
        </Card>
        <Card>
          <Stat
            label="Settling this week"
            value={intPlain(stats.settlingThisWeek)}
            sublabel="scored sides within 7 days"
          />
        </Card>
        <Card>
          <Stat
            label="Upcoming games"
            value={intPlain(stats.upcomingGames)}
            sublabel="sports events with a kickoff time"
          />
        </Card>
      </section>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>
          {CASH_SOON_SORTS.find((s) => s.value === sort)?.label ?? "Ranked"}
        </SectionTitle>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-dim">
          <span>{result.rows.length} shown</span>
          <span>·</span>
          <span>{result.inWindow} settle {windowLabel}</span>
          <span>·</span>
          <AutoRefresh intervalSeconds={60} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-line bg-panel/40 p-3">
        <span className="text-2xs uppercase tracking-caps text-dim">Order by</span>
        {CASH_SOON_SORTS.map((option) => (
          <Link
            key={option.value}
            href={{
              query: {
                ...query,
                sort: option.value === "perDay" ? undefined : option.value,
              },
            }}
            title={option.hint}
            aria-current={sort === option.value ? "true" : undefined}
            className={
              sort === option.value
                ? "rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-2xs text-accent"
                : "rounded border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent/30 hover:text-fg"
            }
          >
            {option.label}
          </Link>
        ))}
        <span className="text-2xs text-dim">
          {CASH_SOON_SORTS.find((s) => s.value === sort)?.hint}
        </span>
      </div>

      <CashSoonFilterBar
        categories={categories}
        window={windowValue}
        showNegativeEdge={showNegativeEdge}
        resultCount={result.rows.length}
      />

      {result.edgeEatenBySpread > 0 && !showNegativeEdge ? (
        <p className="rounded border border-line bg-elevated/40 px-3 py-2 text-2xs leading-5 text-muted">
          <span className="font-mono tabular-nums text-fg">{result.edgeEatenBySpread}</span> other
          {result.edgeEatenBySpread === 1 ? " side settles" : " sides settle"} in this window but are
          hidden because the spread consumes the entire estimated edge — you would be paying more than
          the estimate is worth. That is a real finding rather than a gap in the data.{" "}
          <Link
            href={{ query: { ...query, all: "1" } }}
            className="underline underline-offset-2 hover:text-accent"
          >
            Show them anyway
          </Link>
          .
        </p>
      ) : null}

      {result.rows.length === 0 ? (
        <EmptyState
          title="Nothing worth the capital in this window"
          message={
            result.inWindow === 0
              ? "No scored position settles inside this window. Widen the window above, or run `npm run sync` if the data is stale."
              : `${result.inWindow} scored ${result.inWindow === 1 ? "side settles" : "sides settle"} ${windowLabel}, but none of them keep any edge once the spread is paid. An empty list is a real answer — it means there is nothing here worth tying capital up for.`
          }
          action={
            <Link
              href="/"
              className="rounded border border-line px-2.5 py-1 text-2xs uppercase tracking-caps text-muted hover:border-accent/40 hover:text-accent"
            >
              Back to all opportunities
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {result.rows.map((row, index) => (
            <CashSoonCard
              key={row.id}
              row={row}
              horizon={readHorizon(row)}
              sports={readSports(row)}
              rank={index + 1}
              bankroll={settings.bankroll}
            />
          ))}
        </div>
      )}

      <p className="border-t border-line pt-3 text-2xs leading-4 text-dim">
        PolyAlpha is a research tool. It never places, sizes or signs a trade. Ranking by return per
        day makes two trades comparable; it does not make either of them good.
      </p>
    </div>
  );
}
