/**
 * Smart Money — what tracked traders are actually holding, by market side.
 *
 * This is deliberately broader than the Opportunities list. Opportunities are filtered down to
 * things that could be acted on; this shows the raw picture, including sides that are heavily
 * held but not rankable (illiquid, resolving imminently, one wallet).
 */
import Link from "next/link";
import { prisma } from "@/lib/db";
import {
  formatCents,
  formatSignedCents,
  formatSignedUsd,
  formatTimeUntil,
  formatUsd,
  intPlain,
  UNAVAILABLE,
} from "@/lib/num";
import {
  Badge,
  Card,
  EmptyState,
  Panel,
  SectionTitle,
  Stat,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui/primitives";
import { ViewOnPolymarket } from "@/components/ui/view-on-polymarket";

export const dynamic = "force-dynamic";

export default async function SmartMoneyPage() {
  const consensus = await prisma.marketConsensus.findMany({
    orderBy: [{ exposureUsd: "desc" }],
    take: 80,
    include: {
      market: {
        select: {
          id: true,
          question: true,
          slug: true,
          eventSlug: true,
          category: true,
          outcomes: true,
          endDate: true,
          liquidity: true,
        },
      },
    },
  });

  const totals = await prisma.marketConsensus.aggregate({
    _sum: { exposureUsd: true },
    _count: true,
  });

  const opportunityByKey = new Map(
    (
      await prisma.opportunity.findMany({ select: { id: true, marketId: true, outcomeIndex: true } })
    ).map((o) => [`${o.marketId}:${o.outcomeIndex}`, o.id]),
  );

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Card>
          <Stat
            label="Tracked capital"
            value={formatUsd(totals._sum.exposureUsd)}
            sublabel="Across all held market sides"
          />
        </Card>
        <Card>
          <Stat
            label="Market sides held"
            value={intPlain(totals._count)}
            sublabel="By at least one tracked trader"
          />
        </Card>
        <Card>
          <Stat
            label="Listed as opportunities"
            value={intPlain(opportunityByKey.size)}
            sublabel="Passed the eligibility gate"
          />
        </Card>
      </section>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Positions by market side</SectionTitle>
        <span className="text-2xs text-dim">Ranked by tracked capital</span>
      </div>

      {consensus.length === 0 ? (
        <EmptyState
          title="No tracked positions"
          message="Run `npm run sync` to pull current positions for the traders on your watchlist."
        />
      ) : (
        <Panel>
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Market</TH>
                <TH>Side</TH>
                <TH numeric>Consensus</TH>
                <TH numeric>Holders</TH>
                <TH numeric>Capital</TH>
                <TH numeric>Avg entry</TH>
                <TH numeric>Now</TH>
                <TH numeric>Gap</TH>
                <TH numeric>24h flow</TH>
                <TH>Resolves</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {consensus.map((row) => {
                const outcome =
                  row.market.outcomes[row.outcomeIndex] ?? `Outcome ${row.outcomeIndex}`;
                const opportunityId = opportunityByKey.get(`${row.marketId}:${row.outcomeIndex}`);
                const netFlow24h = row.boughtUsd24h - row.soldUsd24h;

                return (
                  <TR key={row.id}>
                    <TD className="max-w-sm">
                      {opportunityId ? (
                        <Link
                          href={`/opportunities/${opportunityId}`}
                          className="line-clamp-2 text-xs text-fg hover:text-accent"
                        >
                          {row.market.question}
                        </Link>
                      ) : (
                        <span className="line-clamp-2 text-xs text-muted">
                          {row.market.question}
                        </span>
                      )}
                      <span className="text-2xs text-dim">{row.market.category}</span>
                    </TD>

                    <TD>
                      <Badge
                        tone={outcome.toLowerCase() === "no" ? "negative" : "positive"}
                        size="sm"
                      >
                        {outcome}
                      </Badge>
                    </TD>

                    <TD numeric>{row.score === null ? UNAVAILABLE : Math.round(row.score)}</TD>
                    <TD numeric>{intPlain(row.traderCount)}</TD>
                    <TD numeric>{formatUsd(row.exposureUsd)}</TD>
                    <TD numeric>{formatCents(row.weightedEntryPrice)}</TD>
                    <TD numeric>{formatCents(row.currentPrice)}</TD>

                    <TD numeric>
                      <span
                        className={
                          row.entryGap === null
                            ? "text-dim"
                            : row.entryGap <= 0.03
                              ? "text-positive"
                              : "text-warning"
                        }
                      >
                        {formatSignedCents(row.entryGap)}
                      </span>
                    </TD>

                    <TD numeric>
                      <span
                        className={
                          netFlow24h === 0
                            ? "text-dim"
                            : netFlow24h > 0
                              ? "text-positive"
                              : "text-negative"
                        }
                      >
                        {netFlow24h === 0 ? "—" : formatSignedUsd(netFlow24h)}
                      </span>
                    </TD>

                    <TD>
                      <span className="whitespace-nowrap text-2xs text-muted">
                        {formatTimeUntil(row.market.endDate)}
                      </span>
                    </TD>

                    <TD>
                      <ViewOnPolymarket
                        slug={row.market.slug}
                        eventSlug={row.market.eventSlug}
                      />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Panel>
      )}

      <p className="text-2xs leading-4 text-dim">
        Each trader counts once per market side, so a wallet holding several tokens in the same
        outcome cannot inflate the holder count. &ldquo;Gap&rdquo; is the current price minus the
        weighted average price tracked traders paid — a large positive gap means the move has
        largely happened already.
      </p>
    </div>
  );
}
