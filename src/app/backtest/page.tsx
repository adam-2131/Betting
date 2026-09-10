import { prisma } from "@/lib/db";
import type { BacktestResults } from "@/lib/backtest/engine";
import { significanceLabel } from "@/lib/backtest/stats";
import type { RobustnessReport, RobustnessVerdict } from "@/lib/backtest/robustness";
import {
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatSignedPercent,
  intPlain,
} from "@/lib/num";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
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
import { BacktestForm, SweepForm } from "./backtest-form";

export const dynamic = "force-dynamic";

/**
 * Reads the stored JSON blob back as results. The shape is written by our own action, but it has
 * been through the database, so every field is treated as possibly absent.
 */
function asResults(value: unknown): BacktestResults | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<BacktestResults> & { kind?: string };
  if (candidate.kind === "robustness") return null;
  return typeof candidate.signals === "number" ? (candidate as BacktestResults) : null;
}

function asRobustness(value: unknown): RobustnessReport | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { kind?: string; report?: RobustnessReport };
  return candidate.kind === "robustness" && candidate.report ? candidate.report : null;
}

const VERDICT_TONE: Record<RobustnessVerdict, "positive" | "warning" | "negative" | "neutral"> = {
  REPLICATES: "positive",
  INCONSISTENT: "warning",
  "DOES NOT REPLICATE": "warning",
  "NOTHING FOUND": "neutral",
  "TOO LITTLE DATA": "neutral",
};

function formatInterval(interval: { low: number; high: number } | null | undefined): string | null {
  if (!interval) return null;
  return `${(interval.low * 100).toFixed(1)}–${(interval.high * 100).toFixed(1)}%`;
}

function formatP(p: number | null | undefined): string | null {
  if (p === null || p === undefined) return null;
  return p < 0.001 ? "p<0.001" : `p=${p.toFixed(3)}`;
}

function edgeTone(edgePoints: number | null | undefined) {
  if (edgePoints === null || edgePoints === undefined) return "neutral" as const;
  if (edgePoints > 3) return "positive" as const;
  if (edgePoints < -3) return "negative" as const;
  return "neutral" as const;
}

export default async function BacktestPage() {
  const runs = await prisma.backtestRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      createdAt: true,
      label: true,
      params: true,
      results: true,
      signalCount: true,
    },
  });

  const latest = runs.find((run) => asResults(run.results) !== null);
  const results = latest ? asResults(latest.results) : null;
  const latestSweep = runs.find((run) => asRobustness(run.results) !== null);
  const sweep = latestSweep ? asRobustness(latestSweep.results) : null;

  return (
    <div className="space-y-4">
      <SectionTitle>Backtest</SectionTitle>

      <Card>
        <CardHeader title="How look-ahead bias is prevented" />
        <div className="space-y-3 text-2xs leading-5 text-muted">
          <p>
            Look-ahead bias is scoring a past moment with information that did not exist yet. It is
            what makes most backtests look brilliant. Four leaks are possible here, and each is
            closed structurally rather than by being careful:
          </p>

          <div className="space-y-2.5 border-l border-line pl-3">
            <p>
              <span className="text-fg">Trader scores are recomputed at each past date.</span> This
              is the important one. A wallet&apos;s score today includes everything that resolved
              after the signal — and these wallets are tracked precisely <em>because</em> they went
              on to do well. Every historical score here is rebuilt from only the positions that had
              resolved before that date, with the evaluation clock passed into the same scoring
              function the live product uses. A wallet with no prior record scores zero and does not
              qualify, which is correct: at the time, we had no evidence about it.
            </p>
            <p>
              <span className="text-fg">Positions are replayed, not read from the end state.</span>{" "}
              Holdings are rebuilt by walking the trade log up to the signal time. A trader who
              scaled into a winner afterwards does not appear as an early conviction bet.
            </p>
            <p>
              <span className="text-fg">Prices are the last price actually observed.</span> Either a
              stored snapshot captured at or before the signal time, or the most recent tracked fill.
              Nothing is interpolated across the signal time and nothing is back-filled from the
              settlement. Markets with no observable price are skipped and counted, not guessed.
            </p>
            <p>
              <span className="text-fg">The evaluation moment is mechanical.</span> A fixed number of
              days before resolution, identical for every market, declared before the run. Choosing
              the moment &ldquo;when the smart money got in&rdquo; would select the good entries
              after the fact.
            </p>
          </div>

          <p className="text-dim">
            Two limitations cannot be engineered away. The tracked wallets were chosen from
            present-day leaderboards, so the <em>choice of which wallets to follow</em> still
            embeds hindsight even though their scores do not — a positive result here overstates
            what was achievable. And redemption bias in the settled record (losing tokens are often
            never redeemed, so they never appear) inflated historical scores then just as it
            inflates them now.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Why one run is not enough" />
        <div className="space-y-2.5 text-2xs leading-5 text-muted">
          <p>
            A single backtest cannot tell you whether its own result is real. This one initially
            reported a <span className="text-fg">+12.8pp edge in the 20–40 score band at p=0.009</span>{" "}
            — significant, and already corrected for comparing six bands at once. Re-running the
            identical analysis at neighbouring signal horizons gave p-values of 0.007, 0.130, 0.686,
            0.142, 0.017 and 0.565.
          </p>
          <p>
            An effect does not appear at a one-day horizon, vanish at two, three and five days, and
            return at seven. What produced that pattern was searching six configurations and
            reporting the best one. The significance test cannot catch this, because each run only
            sees itself — so the sweep below runs all six and refuses to call anything an edge that
            only shows up in some of them.
          </p>
        </div>
      </Card>

      <SweepForm />

      {sweep ? (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <SectionTitle>Robustness verdict</SectionTitle>
            <span className="text-2xs text-dim">
              {latestSweep ? formatRelativeTime(latestSweep.createdAt) : null}
            </span>
          </div>

          <Card
            className={
              VERDICT_TONE[sweep.verdict] === "positive"
                ? "border-positive/30 bg-positive/[0.04]"
                : VERDICT_TONE[sweep.verdict] === "warning"
                  ? "border-warning/30 bg-warning/[0.04]"
                  : undefined
            }
          >
            <div className="mb-3 flex items-center gap-2">
              <Badge tone={VERDICT_TONE[sweep.verdict]}>{sweep.verdict}</Badge>
              <span className="text-2xs text-dim">
                {sweep.usableHorizons} of {sweep.horizons.length} horizons had enough signals to
                count
              </span>
            </div>
            <div className="space-y-2 text-2xs leading-5 text-muted">
              {sweep.narrative.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </Card>

          <Panel>
            <Table>
              <THead>
                <TR hover={false}>
                  <TH>Horizon</TH>
                  <TH numeric>Signals</TH>
                  <TH numeric>Win rate</TH>
                  <TH numeric>Implied</TH>
                  <TH numeric>Edge</TH>
                  <TH>Best band</TH>
                  <TH numeric>Significance</TH>
                  <TH numeric>Rank r</TH>
                </TR>
              </THead>
              <TBody>
                {sweep.horizons.map((h) => (
                  <TR key={h.horizonDays}>
                    <TD>
                      <span className="font-mono text-2xs text-fg">{h.horizonDays}d</span>
                    </TD>
                    <TD numeric>{intPlain(h.signals)}</TD>
                    <TD numeric>{formatPercent(h.winRate)}</TD>
                    <TD numeric>
                      <span className="text-muted">{formatPercent(h.impliedWinRate)}</span>
                    </TD>
                    <TD numeric>
                      {h.edgePoints === null
                        ? null
                        : `${h.edgePoints >= 0 ? "+" : ""}${h.edgePoints.toFixed(1)}pp`}
                    </TD>
                    <TD>
                      <span className="font-mono text-2xs text-muted">
                        {h.bestBandLabel ?? "—"}
                      </span>
                    </TD>
                    <TD numeric>
                      {h.bestBandPValue === null ? null : (
                        <Badge tone={h.significantAlone ? "accent" : "neutral"} size="sm">
                          {formatP(h.bestBandPValue)}
                        </Badge>
                      )}
                    </TD>
                    <TD numeric>
                      {h.rankCorrelation === null ? null : h.rankCorrelation.toFixed(3)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
          <p className="text-2xs leading-4 text-dim">
            Horizons overlap heavily — they replay largely the same trades — so they are not
            independent experiments, and two agreeing horizons are worth much less than two
            independent ones. A band also tends to win the best-band comparison at most horizons
            regardless, because that is where sample size and variance produce the widest swing.
          </p>
        </section>
      ) : null}

      <BacktestForm />

      {!latest || !results ? (
        <EmptyState
          title="No runs yet"
          message="Run a backtest above. Results depend on stored price and trade history, so a fresh installation will have a short usable window."
        />
      ) : (
        <>
          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <SectionTitle>{latest.label ?? "Latest run"}</SectionTitle>
              <span className="text-2xs text-dim">{formatRelativeTime(latest.createdAt)}</span>
            </div>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Card>
                <Stat
                  label="Signals"
                  value={intPlain(results.signals)}
                  sublabel={`${intPlain(results.marketsTested)} of ${intPlain(results.marketsConsidered)} markets`}
                />
              </Card>
              <Card>
                <Stat
                  label="Win rate"
                  value={formatPercent(results.winRate)}
                  sublabel={
                    <>
                      {formatInterval(results.winRateInterval)
                        ? `95% CI ${formatInterval(results.winRateInterval)}`
                        : null}
                      <span className="mt-0.5 block">
                        Market implied {formatPercent(results.impliedWinRate)}
                      </span>
                    </>
                  }
                />
              </Card>
              <Card>
                <Stat
                  label="Edge vs price"
                  value={
                    results.edgePoints === null
                      ? null
                      : `${results.edgePoints >= 0 ? "+" : ""}${results.edgePoints.toFixed(1)}pp`
                  }
                  tone={edgeTone(results.edgePoints)}
                  sublabel={
                    results.calibration?.overallEdgePValue
                      ? `${formatP(results.calibration.overallEdgePValue)} — ${significanceLabel(results.calibration.overallEdgePValue).text.toLowerCase()}`
                      : "Observed minus implied win rate"
                  }
                />
              </Card>
              <Card>
                <Stat
                  label="Rank correlation"
                  value={
                    results.rankCorrelation === null
                      ? null
                      : results.rankCorrelation.toFixed(3)
                  }
                  tone={edgeTone(
                    results.rankCorrelation === null ? null : results.rankCorrelation * 100,
                  )}
                  sublabel="Score vs outcome. Near zero means the score ranked nothing."
                />
              </Card>
            </div>
          </section>

          {results.warnings.length > 0 ? (
            <Card className="border-warning/30 bg-warning/[0.04]">
              <CardHeader title="Read this before drawing a conclusion" />
              <ul className="space-y-1.5 text-2xs leading-4 text-muted">
                {results.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          <section className="space-y-2">
            <SectionTitle>By opportunity score</SectionTitle>
            <Panel>
              <Table>
                <THead>
                  <TR hover={false}>
                    <TH>Score</TH>
                    <TH numeric>Signals</TH>
                    <TH numeric>Won</TH>
                    <TH numeric>Win rate</TH>
                    <TH numeric>Implied</TH>
                    <TH numeric>Edge</TH>
                    <TH numeric>Return per $1</TH>
                    <TH numeric>95% CI on win rate</TH>
                  </TR>
                </THead>
                <TBody>
                  {results.buckets.map((bucket) => (
                    <TR key={bucket.label}>
                      <TD>
                        <span className="font-mono text-2xs text-fg">{bucket.label}</span>
                      </TD>
                      <TD numeric>{bucket.signals > 0 ? intPlain(bucket.signals) : null}</TD>
                      <TD numeric>{bucket.signals > 0 ? intPlain(bucket.wins) : null}</TD>
                      <TD numeric>{formatPercent(bucket.winRate)}</TD>
                      <TD numeric>
                        <span className="text-muted">{formatPercent(bucket.impliedWinRate)}</span>
                      </TD>
                      <TD numeric>
                        {bucket.edgePoints === null ? null : (
                          <Badge tone={edgeTone(bucket.edgePoints)} size="sm">
                            {`${bucket.edgePoints >= 0 ? "+" : ""}${bucket.edgePoints.toFixed(1)}pp`}
                          </Badge>
                        )}
                      </TD>
                      <TD numeric>{formatSignedPercent(bucket.roi)}</TD>
                      <TD numeric>
                        <span className="text-dim">{formatInterval(bucket.winRateInterval)}</span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Panel>
            {results.priceQuality ? (
              <Card>
                <CardHeader
                  title="Where the benchmark prices came from"
                  subtitle="The implied probability is both what the win rate is compared against and the denominator of the payout, so its freshness decides whether any of the above means anything."
                />
                <div className="grid gap-4 sm:grid-cols-3">
                  <Stat
                    label="From a CLOB curve"
                    value={intPlain(results.priceQuality.bySource.series)}
                    sublabel="Real hourly quote near the signal"
                    tone={results.priceQuality.bySource.series > 0 ? "positive" : "neutral"}
                  />
                  <Stat
                    label="From a stored snapshot"
                    value={intPlain(results.priceQuality.bySource.snapshot)}
                    sublabel="Observed while this install was running"
                  />
                  <Stat
                    label="From the last tracked fill"
                    value={intPlain(results.priceQuality.bySource.trade)}
                    sublabel="Only seen when a wallet happened to trade"
                    tone={
                      results.priceQuality.bySource.trade > results.priceQuality.bySource.series
                        ? "negative"
                        : "neutral"
                    }
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-3 text-2xs text-muted">
                  <span>
                    Median age at signal{" "}
                    <span className="text-fg">
                      {results.priceQuality.medianAgeHours === null
                        ? "Unavailable"
                        : `${results.priceQuality.medianAgeHours.toFixed(1)}h`}
                    </span>
                  </span>
                  <span>
                    90th percentile{" "}
                    <span className="text-fg">
                      {results.priceQuality.p90AgeHours === null
                        ? "Unavailable"
                        : `${results.priceQuality.p90AgeHours.toFixed(1)}h`}
                    </span>
                  </span>
                </div>
              </Card>
            ) : null}

            <p className="text-2xs leading-4 text-dim">
              The <span className="text-muted">Implied</span> column is the average price at signal
              — the market&apos;s own probability, and the benchmark the score must beat. A bucket
              winning 80% of the time at an average price of 82¢ found nothing; only the Edge column
              indicates information. The confidence interval is why a small bucket&apos;s win rate
              should not be read as a measurement: 3 wins from 8 signals reads as 37.5%, but the
              honest range spans 14% to 69%.
            </p>
          </section>

          <Card>
            <CardHeader title="What was skipped, and why" />
            <div className="grid gap-x-6 sm:grid-cols-2">
              <KeyValue
                label="No price observable at signal time"
                value={intPlain(results.skipped.noPriceAtSignal)}
                hint="Never estimated — skipping is the honest option."
              />
              <KeyValue
                label="No tracked holders at signal time"
                value={intPlain(results.skipped.noHoldersAtSignal)}
              />
              <KeyValue
                label="Signal time predates market start"
                value={intPlain(results.skipped.horizonBeforeStart)}
              />
              <KeyValue
                label="Signal time is not yet in the past"
                value={intPlain(results.skipped.signalNotYetPast)}
                hint="Resolution timestamps are upper bounds, so a short horizon can land in the future."
              />
              <KeyValue
                label="Price outside tested band"
                value={intPlain(results.skipped.priceOutOfBand)}
              />
              <KeyValue
                label="No resolved outcome recorded"
                value={intPlain(results.skipped.noResolvedOutcome)}
              />
              <KeyValue
                label="Traders rescored point-in-time"
                value={intPlain(results.tradersScored)}
              />
            </div>
          </Card>

          {results.maxDrawdown !== null ? (
            <Card>
              <CardHeader
                title="Equal-stake drawdown"
                subtitle="Worst peak-to-trough of cumulative profit if every signal had been staked identically, in resolution order."
              />
              <KeyValue
                label="Maximum drawdown"
                value={`${formatNumber(results.maxDrawdown, 2)} per $1 staked per signal`}
                tone="negative"
                hint="Shown to convey variance. It is not a recommendation to stake equally, or at all."
              />
            </Card>
          ) : null}

          {runs.length > 1 ? (
            <section className="space-y-2">
              <SectionTitle>Earlier runs</SectionTitle>
              <Panel>
                <Table>
                  <THead>
                    <TR hover={false}>
                      <TH>Run</TH>
                      <TH>When</TH>
                      <TH numeric>Signals</TH>
                      <TH numeric>Win rate</TH>
                      <TH numeric>Edge</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {runs.slice(1).map((run) => {
                      const runResults = asResults(run.results);
                      return (
                        <TR key={run.id}>
                          <TD>
                            <span className="text-xs text-fg">{run.label ?? "Untitled"}</span>
                          </TD>
                          <TD>
                            <span className="text-2xs text-muted">
                              {formatRelativeTime(run.createdAt)}
                            </span>
                          </TD>
                          <TD numeric>{intPlain(run.signalCount)}</TD>
                          <TD numeric>{formatPercent(runResults?.winRate ?? null)}</TD>
                          <TD numeric>
                            {runResults?.edgePoints === null || runResults?.edgePoints === undefined
                              ? null
                              : `${runResults.edgePoints >= 0 ? "+" : ""}${runResults.edgePoints.toFixed(1)}pp`}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </Panel>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
