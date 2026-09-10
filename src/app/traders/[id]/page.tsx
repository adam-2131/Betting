import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClosedPositions,
  getMonthlyPnl,
  getRealizedPnlCurve,
  getTrader,
} from "@/lib/queries/traders";
import {
  formatCents,
  formatDuration,
  formatPercent,
  formatSignedUsd,
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
import { ViewOnPolymarket } from "@/components/ui/view-on-polymarket";
import {
  CategoryPnlChart,
  CategoryRoiChart,
  CumulativePnlChart,
  EntryBucketChart,
  MonthlyPnlChart,
  WinLossChart,
  type CategoryDatum,
  type EntryBucketDatum,
} from "@/components/trader-charts";

export const dynamic = "force-dynamic";

interface EntryBucketJson {
  bucket?: string;
  count?: number;
  wins?: number;
  staked?: number;
  realizedPnl?: number;
  roi?: number;
}

interface BehaviorReason {
  label?: string;
  detail?: string;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Rebuilds the stored JSON into the shape ScoreBreakdown renders. */
function scoreResult(perf: {
  smartScore: number | null;
  components: unknown;
  penalties: unknown;
}): ScoreResult {
  const components = asArray<ScoreComponent>(perf.components);
  const penalties = asArray<ScorePenalty>(perf.penalties);
  const penaltyTotal = penalties.reduce((acc, p) => acc + (safeNumber(p.points) ?? 0), 0);
  return {
    score: perf.smartScore ?? 0,
    baseScore: (perf.smartScore ?? 0) - penaltyTotal,
    components,
    penalties,
    penaltyTotal,
  };
}

export default async function TraderProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trader = await getTrader(id);
  if (!trader) notFound();

  const [closed, curve, monthly] = await Promise.all([
    getClosedPositions(trader.id, 60),
    getRealizedPnlCurve(trader.id),
    getMonthlyPnl(trader.id),
  ]);

  const perf = trader.performance;

  const categoryData: CategoryDatum[] = trader.categoryPerformance.map((c) => ({
    category: c.category,
    pnl: c.realizedPnl,
    roi: c.roi,
    closedCount: c.closedCount,
  }));

  const entryBuckets: EntryBucketDatum[] = asArray<EntryBucketJson>(perf?.entryBuckets).map((b) => ({
    label: b.bucket ?? "?",
    count: b.count ?? 0,
    winRate: b.count && b.count > 0 ? (b.wins ?? 0) / b.count : null,
    roi: b.roi ?? null,
  }));

  const behaviorReasons = asArray<BehaviorReason>(perf?.behaviorReasons);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Link href="/traders" className="text-2xs text-dim hover:text-accent">
              ← Traders
            </Link>
            <Badge tone="neutral" size="sm">
              {trader.specialty}
            </Badge>
            {!trader.active ? (
              <Badge tone="warning" size="sm">
                Inactive
              </Badge>
            ) : null}
          </div>
          <h1 className="text-lg font-medium text-fg">{trader.displayName}</h1>
          <div className="mt-0.5 font-mono text-2xs text-dim">{trader.wallet}</div>
          {trader.notes ? (
            <p className="mt-2 max-w-prose text-2xs leading-4 text-muted">{trader.notes}</p>
          ) : null}
        </div>

        <a
          href={trader.profileUrl ?? `https://polymarket.com/profile/${trader.wallet}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-2.5 py-1 text-2xs font-medium uppercase tracking-caps text-accent hover:bg-accent/20"
        >
          View profile on Polymarket
          <span aria-hidden="true" className="text-[10px] leading-none">
            ↗
          </span>
        </a>
      </div>

      {(perf?.redemptionBiasSuspected || perf?.historyTruncated) && (
        <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3">
          {perf?.redemptionBiasSuspected ? (
            <p className="text-2xs leading-4 text-warning">
              <span className="font-medium">This record contains no losses, and that is
              suspicious rather than impressive.</span>{" "}
              Polymarket reports a position as closed only once its tokens are redeemed. Winning
              tokens are always redeemed; worthless losing tokens are often abandoned and never
              appear. Treat the win rate and ROI below as an upper bound on real performance. The
              Smart Trader Score applies a penalty for this.
            </p>
          ) : null}
          {perf?.historyTruncated ? (
            <p className="text-2xs leading-4 text-muted">
              History hit the per-sync page cap, so the figures below cover the most recent
              portion of this wallet&apos;s record rather than its full lifetime.
            </p>
          ) : null}
        </div>
      )}

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <Stat
            label="Realized PnL"
            value={formatSignedUsd(perf?.realizedPnl)}
            sublabel="Settled positions only"
            tone={
              perf?.realizedPnl == null ? "neutral" : perf.realizedPnl >= 0 ? "positive" : "negative"
            }
          />
        </Card>
        <Card>
          <Stat
            label="Unrealized PnL"
            value={formatSignedUsd(perf?.unrealizedPnl)}
            sublabel="Open positions — not yet profit"
            tone={
              perf?.unrealizedPnl == null
                ? "neutral"
                : perf.unrealizedPnl >= 0
                  ? "positive"
                  : "negative"
            }
          />
        </Card>
        <Card>
          <Stat
            label="Portfolio value"
            value={formatUsd(perf?.portfolioValue)}
            sublabel={`${intPlain(trader.positions.length)} open positions`}
          />
        </Card>
        <Card>
          <Stat
            label="ROI"
            value={formatPercent(perf?.roi)}
            sublabel={`On ${formatUsd(perf?.totalStaked)} staked`}
            tone={perf?.roi == null ? "neutral" : perf.roi >= 0 ? "positive" : "negative"}
          />
        </Card>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Track record"
              subtitle="Computed from settled positions, never from open ones."
            />
            <div className="grid gap-x-6 sm:grid-cols-2">
              <KeyValue label="Settled positions" value={intPlain(perf?.closedCount)} />
              <KeyValue label="Win rate" value={formatPercent(perf?.winRate)} />
              <KeyValue
                label="Wins / losses"
                value={
                  perf ? `${intPlain(perf.winCount)} / ${intPlain(perf.lossCount)}` : UNAVAILABLE
                }
              />
              <KeyValue label="Average entry" value={formatCents(perf?.avgEntryPrice)} />
              <KeyValue label="Average position" value={formatUsd(perf?.avgPositionUsd)} />
              <KeyValue label="Largest position" value={formatUsd(perf?.largestPositionUsd)} />
              <KeyValue
                label="Largest win"
                value={formatSignedUsd(perf?.largestWinUsd)}
                tone="positive"
              />
              <KeyValue
                label="Largest loss"
                value={formatSignedUsd(perf?.largestLossUsd)}
                tone="negative"
              />
              <KeyValue label="Total trades" value={intPlain(perf?.tradeCount)} />
              <KeyValue
                label="Median hold"
                value={formatDuration(perf?.medianHoldSeconds)}
                hint="Time between entry and exit"
              />
              <KeyValue
                label="Held to resolution"
                value={formatPercent(perf?.heldToResolutionPct)}
              />
              <KeyValue
                label="Position concentration"
                value={perf?.concentrationHhi == null ? UNAVAILABLE : perf.concentrationHhi.toFixed(2)}
                hint="0 = spread evenly, 1 = one position"
              />
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            <CumulativePnlChart data={curve} />
            <MonthlyPnlChart data={monthly} />
            <WinLossChart wins={perf?.winCount ?? 0} losses={perf?.lossCount ?? 0} />
            <EntryBucketChart data={entryBuckets} />
            <CategoryPnlChart data={categoryData} />
            <CategoryRoiChart data={categoryData} />
          </div>
        </div>

        <div className="space-y-4">
          {perf ? (
            <ScoreBreakdown result={scoreResult(perf)} title="Smart Trader Score" />
          ) : (
            <Card>
              <CardHeader title="Smart Trader Score" />
              <p className="text-2xs text-dim">
                Not scored yet. Run <code className="text-muted">npm run sync</code>.
              </p>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Behavior classification"
              subtitle="A heuristic label, not a certainty."
            />
            {perf ? (
              <>
                <div className="flex items-center gap-2">
                  <Badge
                    tone={perf.behaviorClass === "DISCRETIONARY" ? "positive" : "warning"}
                    size="md"
                  >
                    {perf.behaviorClass.replace(/_/g, " ")}
                  </Badge>
                  <span className="font-mono text-2xs text-muted">
                    {perf.behaviorConfidence == null
                      ? UNAVAILABLE
                      : `${Math.round(perf.behaviorConfidence * 100)}% confidence`}
                  </span>
                </div>

                {behaviorReasons.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {behaviorReasons.map((reason, i) => (
                      <li key={i} className="text-2xs leading-4">
                        <span className="text-fg">{reason.label}</span>
                        {reason.detail ? (
                          <span className="text-muted"> — {reason.detail}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <p className="mt-3 border-t border-line pt-3 text-2xs leading-4 text-dim">
                  Derived from trade frequency, median holding time, repeated small trades,
                  both-outcome activity and share held to resolution. These patterns are
                  suggestive, not conclusive.
                </p>
              </>
            ) : (
              <p className="text-2xs text-dim">{UNAVAILABLE}</p>
            )}
          </Card>

          <Card>
            <CardHeader title="Category record" subtitle="Skill score shrinks toward neutral on small samples." />
            {trader.categoryPerformance.length === 0 ? (
              <p className="text-2xs text-dim">No settled positions by category yet.</p>
            ) : (
              <div className="space-y-0">
                {trader.categoryPerformance.map((c) => (
                  <KeyValue
                    key={c.id}
                    label={c.category}
                    hint={`${intPlain(c.closedCount)} settled · ${formatPercent(c.winRate)} win rate`}
                    value={c.skillScore == null ? UNAVAILABLE : Math.round(c.skillScore)}
                    tone={
                      c.skillScore == null ? "neutral" : c.skillScore >= 55 ? "positive" : "neutral"
                    }
                  />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <section className="space-y-2">
        <SectionTitle>Open positions</SectionTitle>
        {trader.positions.length === 0 ? (
          <p className="text-2xs text-dim">No open positions.</p>
        ) : (
          <Panel>
            <Table>
              <THead>
                <TR hover={false}>
                  <TH>Market</TH>
                  <TH>Side</TH>
                  <TH numeric>Entry</TH>
                  <TH numeric>Now</TH>
                  <TH numeric>Value</TH>
                  <TH numeric>Unrealized</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {trader.positions.slice(0, 40).map((p) => (
                  <TR key={p.id}>
                    <TD className="max-w-md">
                      <span className="line-clamp-2 text-xs">{p.market.question}</span>
                    </TD>
                    <TD>
                      <Badge tone={p.outcome?.toLowerCase() === "no" ? "negative" : "positive"} size="sm">
                        {p.outcome ?? `#${p.outcomeIndex}`}
                      </Badge>
                    </TD>
                    <TD numeric>{formatCents(p.avgPrice)}</TD>
                    <TD numeric>{formatCents(p.curPrice)}</TD>
                    <TD numeric>{formatUsd(p.currentValue)}</TD>
                    <TD numeric>
                      <span
                        className={
                          p.cashPnl == null
                            ? "text-dim"
                            : p.cashPnl >= 0
                              ? "text-positive"
                              : "text-negative"
                        }
                      >
                        {formatSignedUsd(p.cashPnl)}
                      </span>
                    </TD>
                    <TD>
                      <ViewOnPolymarket slug={p.market.slug} eventSlug={p.market.eventSlug} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle>Recent settled positions</SectionTitle>
        {closed.length === 0 ? (
          <p className="text-2xs text-dim">No settled positions.</p>
        ) : (
          <Panel>
            <Table>
              <THead>
                <TR hover={false}>
                  <TH>Market</TH>
                  <TH>Side</TH>
                  <TH>Result</TH>
                  <TH numeric>Entry</TH>
                  <TH numeric>Staked</TH>
                  <TH numeric>Realized</TH>
                  <TH>Resolved</TH>
                </TR>
              </THead>
              <TBody>
                {closed.map((c) => (
                  <TR key={c.id}>
                    <TD className="max-w-md">
                      <span className="line-clamp-2 text-xs">{c.title ?? UNAVAILABLE}</span>
                    </TD>
                    <TD>
                      <span className="text-2xs text-muted">{c.outcome ?? UNAVAILABLE}</span>
                    </TD>
                    <TD>
                      {c.won === null ? (
                        <span className="text-2xs text-dim">Unclear</span>
                      ) : (
                        <Badge tone={c.won ? "positive" : "negative"} size="sm">
                          {c.won ? "Won" : "Lost"}
                        </Badge>
                      )}
                    </TD>
                    <TD numeric>{formatCents(c.avgPrice)}</TD>
                    <TD numeric>{formatUsd(c.costBasisUsd)}</TD>
                    <TD numeric>
                      <span
                        className={
                          c.realizedPnl == null
                            ? "text-dim"
                            : c.realizedPnl >= 0
                              ? "text-positive"
                              : "text-negative"
                        }
                      >
                        {formatSignedUsd(c.realizedPnl)}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-2xs text-muted">
                        {c.resolvedAt ? c.resolvedAt.toISOString().slice(0, 10) : UNAVAILABLE}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
        )}
      </section>
    </div>
  );
}
