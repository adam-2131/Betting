import Link from "next/link";
import type { BehaviorClass } from "@prisma/client";
import { listTraders } from "@/lib/queries/traders";
import { formatPercent, formatSignedUsd, formatUsd, intPlain, UNAVAILABLE } from "@/lib/num";
import {
  Badge,
  EmptyState,
  Panel,
  SectionTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  type Tone,
} from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

const BEHAVIOR_TONE: Record<BehaviorClass, Tone> = {
  DISCRETIONARY: "positive",
  POSSIBLE_BOT: "warning",
  SCALPER: "warning",
  MARKET_MAKER: "warning",
  UNKNOWN: "neutral",
};

const BEHAVIOR_LABEL: Record<BehaviorClass, string> = {
  DISCRETIONARY: "Discretionary",
  POSSIBLE_BOT: "Possible bot",
  SCALPER: "Scalper",
  MARKET_MAKER: "Market maker",
  UNKNOWN: "Unknown",
};

function scoreTone(score: number | null | undefined): string {
  if (score == null) return "text-dim";
  if (score >= 65) return "text-positive";
  if (score >= 45) return "text-accent";
  return "text-fg";
}

export default async function TradersPage() {
  const traders = await listTraders({ includeInactive: true });
  const scored = traders.filter((t) => t.performance?.smartScore != null).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Tracked traders</SectionTitle>
        <div className="text-2xs text-dim">
          {traders.length} tracked · {scored} scored
        </div>
      </div>

      {traders.length === 0 ? (
        <EmptyState
          title="No traders tracked yet"
          message="Seed the watchlist with `npm run db:seed -- --discover=120`, then run `npm run sync` to pull their positions and history."
        />
      ) : (
        <Panel>
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Trader</TH>
                <TH numeric>Score</TH>
                <TH>Behavior</TH>
                <TH numeric>Realized PnL</TH>
                <TH numeric>Unrealized</TH>
                <TH numeric>Win rate</TH>
                <TH numeric>Settled</TH>
                <TH numeric>Open</TH>
                <TH>Flags</TH>
              </TR>
            </THead>
            <TBody>
              {traders.map((trader) => {
                const perf = trader.performance;
                return (
                  <TR key={trader.id}>
                    <TD>
                      <Link
                        href={`/traders/${trader.id}`}
                        className="font-medium text-fg hover:text-accent"
                      >
                        {trader.displayName}
                      </Link>
                      <div className="font-mono text-2xs text-dim">
                        {trader.wallet.slice(0, 10)}…{trader.wallet.slice(-6)}
                        {!trader.active ? " · inactive" : null}
                      </div>
                    </TD>

                    <TD numeric>
                      <span className={scoreTone(perf?.smartScore)}>
                        {perf?.smartScore == null ? UNAVAILABLE : Math.round(perf.smartScore)}
                      </span>
                    </TD>

                    <TD>
                      {perf ? (
                        <Badge tone={BEHAVIOR_TONE[perf.behaviorClass]} size="sm">
                          {BEHAVIOR_LABEL[perf.behaviorClass]}
                        </Badge>
                      ) : (
                        <span className="text-2xs text-dim">{UNAVAILABLE}</span>
                      )}
                    </TD>

                    <TD numeric>
                      <span
                        className={
                          perf?.realizedPnl == null
                            ? "text-dim"
                            : perf.realizedPnl >= 0
                              ? "text-positive"
                              : "text-negative"
                        }
                      >
                        {formatSignedUsd(perf?.realizedPnl)}
                      </span>
                    </TD>

                    <TD numeric>
                      <span
                        className={
                          perf?.unrealizedPnl == null
                            ? "text-dim"
                            : perf.unrealizedPnl >= 0
                              ? "text-positive"
                              : "text-negative"
                        }
                      >
                        {formatSignedUsd(perf?.unrealizedPnl)}
                      </span>
                    </TD>

                    <TD numeric>{formatPercent(perf?.winRate)}</TD>
                    <TD numeric>{intPlain(perf?.closedCount)}</TD>
                    <TD numeric>{intPlain(trader._count.positions)}</TD>

                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {perf?.redemptionBiasSuspected ? (
                          <Badge
                            tone="warning"
                            size="sm"
                            title="Every settled position in the record is a win. Polymarket only reports a closed position once its tokens are redeemed, and worthless losing tokens are often left unredeemed — so this is very likely an incomplete record rather than a perfect one."
                          >
                            Winners only
                          </Badge>
                        ) : null}
                        {perf?.historyTruncated ? (
                          <Badge
                            tone="neutral"
                            size="sm"
                            title="History hit the per-sync page cap, so these figures cover the most recent subset rather than the full lifetime record."
                          >
                            Truncated
                          </Badge>
                        ) : null}
                        {trader.syncError ? (
                          <Badge tone="negative" size="sm" title={trader.syncError}>
                            Sync error
                          </Badge>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Panel>
      )}

      <p className="text-2xs leading-4 text-dim">
        Behavior classification is a heuristic based on trade frequency, holding times and
        repetition. It is a label, not a certainty. Realized and unrealized PnL are kept separate
        throughout — open-position gains are not profit until the market settles.
      </p>

      {traders.some((t) => t.performance?.redemptionBiasSuspected) ? (
        <p className="text-2xs leading-4 text-warning">
          Some wallets show no losses at all. That is a reporting artefact rather than a perfect
          record: settled positions only appear once redeemed, and losing tokens are frequently
          abandoned. Those wallets carry a scoring penalty for it.
        </p>
      ) : null}
    </div>
  );
}
