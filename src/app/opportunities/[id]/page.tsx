import Link from "next/link";
import { notFound } from "next/navigation";
import type { SignalType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getOpportunityById } from "@/lib/queries/opportunities";
import { getSettings } from "@/lib/settings";
import {
  formatCents,
  formatPercent,
  formatSignedCents,
  formatTimeUntil,
  formatUsd,
  intPlain,
  safeNumber,
  UNAVAILABLE,
} from "@/lib/num";
import type { ScoreComponent, ScorePenalty, ScoreResult } from "@/lib/scoring/types";
import {
  Badge,
  Card,
  CardHeader,
  KeyValue,
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
import { ScoreBreakdown } from "@/components/ui/score-breakdown";
import { SignalBadgeList } from "@/components/ui/signal-badge";
import { ViewOnPolymarket } from "@/components/ui/view-on-polymarket";
import { PayoutCalculator } from "@/components/payout-calculator";
import { AnalyzePanel } from "@/components/analyze-panel";

export const dynamic = "force-dynamic";

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function reasonList(value: unknown): string[] {
  return asArray<string | { text?: string }>(value)
    .map((item) => (typeof item === "string" ? item : (item?.text ?? "")))
    .filter((text) => text.length > 0);
}

function scoreResult(row: { score: number; components: unknown; penalties: unknown }): ScoreResult {
  const components = asArray<ScoreComponent>(row.components);
  const penalties = asArray<ScorePenalty>(row.penalties);
  const penaltyTotal = penalties.reduce((acc, p) => acc + (safeNumber(p.points) ?? 0), 0);
  return {
    score: row.score,
    baseScore: row.score - penaltyTotal,
    components,
    penalties,
    penaltyTotal,
  };
}

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [opportunity, settings] = await Promise.all([getOpportunityById(id), getSettings()]);
  if (!opportunity) notFound();

  const { market } = opportunity;
  const price = safeNumber(opportunity.currentPrice);
  const outcomeLabel = market.outcomes[opportunity.outcomeIndex] ?? `Outcome ${opportunity.outcomeIndex}`;

  // Who is actually behind this signal. Named holders are the whole point of the product.
  const holders = await prisma.position.findMany({
    where: {
      marketId: market.id,
      outcomeIndex: opportunity.outcomeIndex,
      isOpen: true,
      size: { gt: 0 },
    },
    orderBy: { currentValue: "desc" },
    include: {
      trader: {
        select: {
          id: true,
          displayName: true,
          performance: { select: { smartScore: true, behaviorClass: true } },
        },
      },
    },
  });

  const reasonsFor = reasonList(opportunity.reasonsFor);
  const reasonsAgainst = reasonList(opportunity.reasonsAgainst);
  const gap = safeNumber(opportunity.entryGap);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Link href="/" className="text-2xs text-dim hover:text-accent">
              ← Opportunities
            </Link>
            <Badge tone="neutral" size="sm">
              {market.category}
            </Badge>
            <Badge tone={outcomeLabel.toLowerCase() === "no" ? "negative" : "positive"} size="sm">
              {outcomeLabel.toUpperCase()}
            </Badge>
            {opportunity.riskLevel ? (
              <Badge tone="warning" size="sm">
                {opportunity.riskLevel} RISK
              </Badge>
            ) : null}
          </div>
          <h1 className="max-w-3xl text-base font-medium leading-6 text-fg">{market.question}</h1>
        </div>

        <ViewOnPolymarket slug={market.slug} eventSlug={market.eventSlug} />
      </div>

      <SignalBadgeList
        signals={opportunity.signals.map((s) => ({ type: s.type as SignalType, detail: s.detail }))}
      />

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <Stat
            label="Opportunity score"
            value={Math.round(opportunity.score)}
            sublabel="0–100, fully broken down below"
            tone={opportunity.score >= 60 ? "positive" : "neutral"}
          />
        </Card>
        <Card>
          <Stat
            label="Current price"
            value={formatCents(price)}
            sublabel={`Implied probability ${formatPercent(price, 0)}`}
          />
        </Card>
        <Card>
          <Stat
            label="Smart money"
            value={
              opportunity.consensusScore === null
                ? UNAVAILABLE
                : Math.round(opportunity.consensusScore)
            }
            sublabel={`${intPlain(opportunity.qualifiedTraders)} qualified · ${intPlain(opportunity.opposingTraders)} opposing`}
          />
        </Card>
        <Card>
          <Stat
            label="Entry gap"
            value={formatSignedCents(gap)}
            sublabel={`vs ${formatCents(opportunity.weightedEliteEntry)} tracked entry`}
            tone={gap === null ? "neutral" : gap <= 0.03 ? "positive" : "negative"}
          />
        </Card>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="space-y-4">
          {/* First on the page, because everything below it is a cached snapshot and this is not. */}
          <AnalyzePanel opportunityId={opportunity.id} />

          {reasonsFor.length > 0 || reasonsAgainst.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader title="Why it is interesting" />
                {reasonsFor.length === 0 ? (
                  <p className="text-2xs text-dim">Nothing stands out on the positive side.</p>
                ) : (
                  <ul className="space-y-2">
                    {reasonsFor.map((text, i) => (
                      <li key={i} className="flex gap-2 text-2xs leading-4 text-muted">
                        <span className="text-positive">+</span>
                        <span>{text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card>
                <CardHeader title="Why it could fail" />
                {reasonsAgainst.length === 0 ? (
                  <p className="text-2xs text-dim">No specific warnings were triggered.</p>
                ) : (
                  <ul className="space-y-2">
                    {reasonsAgainst.map((text, i) => (
                      <li key={i} className="flex gap-2 text-2xs leading-4 text-muted">
                        <span className="text-warning">−</span>
                        <span>{text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          ) : null}

          <Card>
            <CardHeader title="Market" />
            <div className="grid gap-x-6 sm:grid-cols-2">
              <KeyValue label="Liquidity" value={formatUsd(market.liquidity)} />
              <KeyValue label="Volume" value={formatUsd(market.volume)} />
              <KeyValue
                label="Spread"
                value={market.spread === null ? UNAVAILABLE : formatCents(market.spread)}
              />
              <KeyValue label="Resolves" value={formatTimeUntil(market.endDate)} />
              <KeyValue
                label="Resolution clarity"
                value={
                  market.clarityScore === null ? UNAVAILABLE : Math.round(market.clarityScore)
                }
                hint="Heuristic scan of the resolution text"
              />
              <KeyValue label="Category" value={market.category} />
            </div>
          </Card>

          <section className="space-y-2">
            <SectionTitle>Who is holding this side</SectionTitle>
            {holders.length === 0 ? (
              <p className="text-2xs text-dim">
                No tracked trader currently holds this side.
              </p>
            ) : (
              <Panel>
                <Table>
                  <THead>
                    <TR hover={false}>
                      <TH>Trader</TH>
                      <TH numeric>Score</TH>
                      <TH>Behavior</TH>
                      <TH numeric>Entry</TH>
                      <TH numeric>Position</TH>
                      <TH numeric>Unrealized</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {holders.map((h) => (
                      <TR key={h.id}>
                        <TD>
                          <Link
                            href={`/traders/${h.trader.id}`}
                            className="text-xs text-fg hover:text-accent"
                          >
                            {h.trader.displayName}
                          </Link>
                        </TD>
                        <TD numeric>
                          {h.trader.performance?.smartScore == null
                            ? UNAVAILABLE
                            : Math.round(h.trader.performance.smartScore)}
                        </TD>
                        <TD>
                          <span className="text-2xs text-muted">
                            {h.trader.performance?.behaviorClass.replace(/_/g, " ") ?? UNAVAILABLE}
                          </span>
                        </TD>
                        <TD numeric>{formatCents(h.avgPrice)}</TD>
                        <TD numeric>{formatUsd(h.currentValue)}</TD>
                        <TD numeric>
                          <span
                            className={
                              h.cashPnl == null
                                ? "text-dim"
                                : h.cashPnl >= 0
                                  ? "text-positive"
                                  : "text-negative"
                            }
                          >
                            {h.cashPnl == null ? UNAVAILABLE : formatUsd(h.cashPnl)}
                          </span>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Panel>
            )}
          </section>

          <ScoreBreakdown result={scoreResult(opportunity)} title="Opportunity score breakdown" />
        </div>

        <div className="space-y-4">
          <PayoutCalculator
            price={price}
            bankroll={settings.bankroll}
            outcomeLabel={outcomeLabel.toUpperCase()}
          />

          {opportunity.modelEstimateMid !== null ? (
            <Card>
              <CardHeader
                title="Model estimate"
                subtitle="A quantitative read of the smart-money signal, not a forecast of the event."
              />
              <div className="flex items-end gap-2">
                <span className="font-mono text-3xl leading-none tabular-nums text-fg">
                  {formatPercent(opportunity.modelEstimateMid, 0)}
                </span>
                {opportunity.modelEstimateLow !== null && opportunity.modelEstimateHigh !== null ? (
                  <span className="text-2xs text-dim">
                    range {formatPercent(opportunity.modelEstimateLow, 0)}–
                    {formatPercent(opportunity.modelEstimateHigh, 0)}
                  </span>
                ) : null}
              </div>

              <div className="mt-3 grid gap-x-6">
                <KeyValue label="Market price" value={formatCents(price)} />
                <KeyValue
                  label="Implied edge"
                  value={
                    opportunity.edgePoints === null
                      ? UNAVAILABLE
                      : `${opportunity.edgePoints >= 0 ? "+" : ""}${opportunity.edgePoints.toFixed(1)} pts`
                  }
                />
                <KeyValue
                  label="EV per share"
                  value={
                    opportunity.evPerShare === null
                      ? UNAVAILABLE
                      : formatUsd(opportunity.evPerShare)
                  }
                />
              </div>

              <p className="mt-3 border-t border-line pt-3 text-2xs leading-4 text-warning">
                This is a model estimate, not a guaranteed edge. It is derived from what tracked
                traders have done, and they can be wrong together.
              </p>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
