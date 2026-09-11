/**
 * THE BET LOG — the only screen that measures the product rather than the market.
 *
 * Closing line value is the headline and win rate is deliberately secondary, which is the opposite
 * of what feels natural. The reason is sample size: a win or a loss is one bit, so telling a real
 * edge from a lucky streak takes hundreds of settled bets, and this project's backtest is a case
 * study in how long a flattering number survives before anyone checks. CLV yields a continuous
 * measurement per bet, so the mean stabilises in tens.
 *
 * The verdict is allowed to say "stop". A feedback loop that can only encourage is decoration.
 */
import Link from "next/link";
import { prisma } from "@/lib/db";
import { describeClv, MIN_SAMPLE, summarizeClv } from "@/lib/clv";
import { formatCents, formatRelativeTime, formatSignedUsd, formatUsd, intPlain } from "@/lib/num";
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
  Unavailable,
  type Tone,
} from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

const VERDICT_TONE: Record<string, Tone> = {
  BEATING_THE_CLOSE: "positive",
  PAYING_UP: "negative",
  INCONCLUSIVE: "warning",
  TOO_FEW: "neutral",
};

const VERDICT_LABEL: Record<string, string> = {
  BEATING_THE_CLOSE: "BEATING THE CLOSE",
  PAYING_UP: "PAYING ABOVE THE CLOSE",
  INCONCLUSIVE: "NOT YET DISTINGUISHABLE",
  TOO_FEW: "TOO FEW MEASURED",
};

export default async function BetsPage() {
  const bets = await prisma.betLog.findMany({
    orderBy: { placedAt: "desc" },
    take: 200,
    include: { market: { select: { slug: true, eventSlug: true, gameStartTime: true } } },
  });

  const measured = bets.filter((b) => b.clvPoints !== null);
  const summary = summarizeClv(
    measured.map((b) => ({ entryPrice: b.entryPrice, closingPrice: b.closingPrice ?? 0 })),
  );

  const settled = bets.filter((b) => b.resolved);
  const wins = settled.filter((b) => b.won).length;
  const totalPnl = settled.reduce((acc, b) => acc + (b.pnl ?? 0), 0);
  const staked = bets.reduce((acc, b) => acc + b.stake, 0);

  return (
    <div className="space-y-5">
      <Card>
        <h1 className="text-sm font-medium text-fg">Your bets</h1>
        <p className="mt-1 max-w-prose text-2xs leading-5 text-muted">
          The headline here is <strong className="text-fg">closing line value</strong>, not win
          rate. A market&rsquo;s price just before it closes is the most accurate figure it ever
          produces, so buying below it means you were ahead of the market and buying above it means
          you were behind — whether or not that particular bet came in. It is a number per bet
          rather than a win or a loss, so it tells you something after tens of bets instead of
          hundreds. Positive CLV is not profit; costs still have to be cleared. It is the necessary
          half, not the sufficient one.
        </p>
      </Card>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <Stat
            label="Average CLV"
            value={
              summary.meanPoints === null
                ? "Unavailable"
                : `${summary.meanPoints >= 0 ? "+" : ""}${summary.meanPoints.toFixed(2)} pts`
            }
            sublabel={
              summary.count < MIN_SAMPLE
                ? `${summary.count} of ${MIN_SAMPLE} needed`
                : `95% range ${(summary.intervalLow ?? 0).toFixed(1)} to ${(summary.intervalHigh ?? 0).toFixed(1)}`
            }
            tone={
              summary.meanPoints === null
                ? "neutral"
                : summary.meanPoints > 0
                  ? "positive"
                  : "negative"
            }
          />
        </Card>
        <Card>
          <Stat
            label="Bought below the close"
            value={
              summary.positiveRate === null
                ? "Unavailable"
                : `${Math.round(summary.positiveRate * 100)}%`
            }
            sublabel={`${measured.length} bet${measured.length === 1 ? "" : "s"} measured`}
          />
        </Card>
        <Card>
          <Stat
            label="Logged"
            value={intPlain(bets.length)}
            sublabel={`${formatUsd(staked)} staked in total`}
          />
        </Card>
        <Card>
          <Stat
            label="Settled record"
            value={settled.length === 0 ? "Unavailable" : `${wins}/${settled.length}`}
            sublabel={
              settled.length === 0
                ? "nothing has resolved yet"
                : `${formatSignedUsd(totalPnl)} — needs hundreds to mean anything`
            }
            tone={totalPnl > 0 ? "positive" : totalPnl < 0 ? "negative" : "neutral"}
          />
        </Card>
      </section>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>What the log says so far</SectionTitle>
          <Badge tone={VERDICT_TONE[summary.verdict] ?? "neutral"} size="sm">
            {VERDICT_LABEL[summary.verdict] ?? summary.verdict}
          </Badge>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted">{describeClv(summary)}</p>
      </Card>

      {bets.length === 0 ? (
        <EmptyState
          title="No bets logged yet"
          message="Press “I bet this” on any card to record it. The price is read live from the order book at that moment, and once the market closes this page compares it with the market's final price. That comparison is the fastest honest answer to whether any of this is working."
          action={
            <Link
              href="/cash-soon"
              className="rounded border border-line px-2.5 py-1 text-2xs uppercase tracking-caps text-muted hover:border-accent/40 hover:text-accent"
            >
              Go to the board
            </Link>
          }
        />
      ) : (
        <Panel>
          <Table>
            <THead>
              <TR>
                <TH>Bet</TH>
                <TH numeric>Paid</TH>
                <TH numeric>Closed</TH>
                <TH numeric>CLV</TH>
                <TH numeric>Score</TH>
                <TH numeric>Result</TH>
                <TH>Placed</TH>
              </TR>
            </THead>
            <TBody>
              {bets.map((bet) => (
                <TR key={bet.id}>
                  <TD>
                    <div className="max-w-md">
                      <div className="truncate text-xs text-fg">{bet.outcomeLabel}</div>
                      <div className="truncate text-2xs text-dim">{bet.question}</div>
                    </div>
                  </TD>
                  <TD numeric>{formatCents(bet.entryPrice)}</TD>
                  <TD numeric>
                    {bet.closingPrice === null ? (
                      <span className="font-sans text-2xs text-dim">
                        {bet.clvSource === "UNAVAILABLE" ? "no history" : "pending"}
                      </span>
                    ) : (
                      formatCents(bet.closingPrice)
                    )}
                  </TD>
                  <TD numeric>
                    {bet.clvPoints === null ? (
                      <Unavailable />
                    ) : (
                      <span className={bet.clvPoints >= 0 ? "text-positive" : "text-negative"}>
                        {bet.clvPoints >= 0 ? "+" : ""}
                        {bet.clvPoints.toFixed(1)}
                      </span>
                    )}
                  </TD>
                  <TD numeric>
                    {bet.horizonScore === null ? <Unavailable /> : Math.round(bet.horizonScore)}
                  </TD>
                  <TD numeric>
                    {!bet.resolved ? (
                      <span className="font-sans text-2xs text-dim">open</span>
                    ) : (
                      <span className={bet.won ? "text-positive" : "text-negative"}>
                        {bet.won ? "won" : "lost"} {formatSignedUsd(bet.pnl)}
                      </span>
                    )}
                  </TD>
                  <TD>
                    <span className="text-2xs text-dim">{formatRelativeTime(bet.placedAt)}</span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Panel>
      )}

      <p className="border-t border-line pt-3 text-2xs leading-4 text-dim">
        Closing prices come from Polymarket&rsquo;s own price history, sampled strictly at or before
        the close — kickoff for a game, the end date otherwise. CLOB history reaches back weeks, not
        months, so a bet left unmeasured for too long is marked “no history” rather than compared
        against a substitute price.
      </p>
    </div>
  );
}
