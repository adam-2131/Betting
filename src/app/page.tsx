/**
 * Home / Opportunities — the main screen.
 *
 * Opens in the filter state saved in Settings, because the defaults there (exclude bots, minimum
 * consensus, minimum liquidity) encode what makes a signal worth looking at. The header states
 * how many rows the filters removed so a short list never looks like missing data.
 *
 * Category and resolution-window narrowing sits in the URL on top of that baseline — see
 * `opportunity-filters.tsx` for why those two are not stored in Settings.
 */
import Link from "next/link";
import {
  getDashboardStats,
  listOpportunities,
  listOpportunityCategories,
  filtersFromSettings,
} from "@/lib/queries/opportunities";
import { getSettings } from "@/lib/settings";
import { formatRelativeTime, formatUsd, intPlain } from "@/lib/num";
import { Card, EmptyState, SectionTitle, Stat } from "@/components/ui/primitives";
import { OpportunityCard } from "@/components/opportunity-card";
import { parseCategories, resolutionHours } from "./filter-params";
import { OpportunityFilterBar } from "./opportunity-filters";
import { AutoRefresh } from "@/components/auto-refresh";
import { HowToRead } from "@/components/how-to-read";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; window?: string }>;
}) {
  const query = await searchParams;
  const categories = parseCategories(query.category);
  const windowValue = query.window ?? "any";
  const resolvesWithinHours = resolutionHours(windowValue);

  const [stats, settings, filters, availableCategories] = await Promise.all([
    getDashboardStats(),
    getSettings(),
    filtersFromSettings(),
    listOpportunityCategories(),
  ]);

  const { rows, totalBeforeFilters } = await listOpportunities({
    ...filters,
    categories: categories.length > 0 ? categories : undefined,
    resolvesWithinHours: resolvesWithinHours ?? undefined,
    limit: 50,
  });
  const hidden = totalBeforeFilters - rows.length;
  const narrowed = categories.length > 0 || windowValue !== "any";

  return (
    <div className="space-y-5">
      <HowToRead />

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <Stat
            label="Top opportunity"
            value={rows[0] ? Math.round(rows[0].score) : "Unavailable"}
            sublabel={rows[0]?.market.question.slice(0, 60) ?? "Nothing passes the filters"}
            tone={rows[0] ? "positive" : "neutral"}
          />
        </Card>
        <Card>
          <Stat
            label="Smart money 24h"
            value={intPlain(stats.smartMoneyEvents24h)}
            sublabel={
              stats.smartMoneyVolume24h === null
                ? "trades by tracked traders"
                : `trades · ${formatUsd(stats.smartMoneyVolume24h)} volume`
            }
          />
        </Card>
        <Card>
          <Stat
            label="Tracked traders"
            value={intPlain(stats.activeTraders)}
            sublabel={
              stats.trackedTraders === stats.activeTraders
                ? "all active"
                : `${stats.trackedTraders} total, ${stats.trackedTraders - stats.activeTraders} inactive`
            }
          />
        </Card>
        <Card>
          <Stat
            label="Strong consensus"
            value={intPlain(stats.strongConsensusMarkets)}
            sublabel="market sides scoring 60+"
          />
        </Card>
      </section>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Ranked opportunities</SectionTitle>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-dim">
          {stats.lastSyncAt ? <span>Data synced {formatRelativeTime(stats.lastSyncAt)}</span> : null}
          <span>·</span>
          <span>{rows.length} shown</span>
          {hidden > 0 ? (
            <>
              <span>·</span>
              <span>{hidden} filtered out</span>
            </>
          ) : null}
          <span>·</span>
          <Link href="/settings" className="text-muted underline-offset-2 hover:text-accent hover:underline">
            adjust thresholds
          </Link>
          <span>·</span>
          <AutoRefresh intervalSeconds={60} />
        </div>
      </div>

      <OpportunityFilterBar
        categories={categories}
        window={windowValue}
        availableCategories={availableCategories}
        resultCount={rows.length}
      />

      {rows.length === 0 ? (
        <EmptyState
          title={
            narrowed
              ? "Nothing matches this category and time window"
              : "No opportunities pass the current filters"
          }
          message={
            totalBeforeFilters === 0
              ? "Nothing has been scored yet. Run `npm run sync` to pull live market and trader data, then reload."
              : narrowed
                ? "Widen the category or resolution window above. The thresholds saved in Settings still apply underneath these, so an empty list here may just mean nothing in this slice clears your minimum consensus or liquidity."
                : `${totalBeforeFilters} scored ${totalBeforeFilters === 1 ? "side is" : "sides are"} stored, but none meet the current thresholds. An empty list is a real answer — it means no tracked trader is backing anything that clears your bar right now.`
          }
          action={
            <Link
              href="/settings"
              className="rounded border border-line px-2.5 py-1 text-2xs uppercase tracking-caps text-muted hover:border-accent/40 hover:text-accent"
            >
              Review filters
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row, index) => (
            <OpportunityCard
              key={row.id}
              opportunity={row}
              rank={index + 1}
              bankroll={settings.bankroll}
            />
          ))}
        </div>
      )}

      <p className="border-t border-line pt-3 text-2xs leading-4 text-dim">
        PolyAlpha is a research tool. It never places, sizes or signs a trade, and it holds no
        credentials. Scores describe what tracked traders have done, not what will happen.
      </p>
    </div>
  );
}
