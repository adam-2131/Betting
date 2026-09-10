/**
 * Backtest runner.
 *
 *   npm run backtest
 *   npm run backtest -- --horizon=14 --lookback=365 --min-holders=2
 *
 * Prints the same figures the Backtest page shows, and stores the run so it appears there.
 * See src/lib/backtest/engine.ts for how look-ahead bias is prevented.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { DEFAULT_BACKTEST_PARAMS, runBacktest } from "../src/lib/backtest/engine";
import { DEFAULT_HORIZONS, runRobustnessSweep } from "../src/lib/backtest/robustness";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/scoring/config";

const DAY_MS = 86_400_000;

function numberArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const parsed = Number(arg.split("=")[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=").slice(1).join("=") : undefined;
}

function pct(value: number | null, decimals = 1): string {
  return value === null ? "     n/a" : `${(value * 100).toFixed(decimals).padStart(6)}%`;
}

async function main() {
  const horizonDays = numberArg("horizon", 7);
  const lookbackDays = numberArg("lookback", 365);
  const minHolders = numberArg("min-holders", 1);
  const maxMarkets = numberArg("max-markets", 1500);
  const label = stringArg("label");
  const save = !process.argv.includes("--no-save");

  const to = new Date();
  const params = {
    ...DEFAULT_BACKTEST_PARAMS,
    from: new Date(to.getTime() - lookbackDays * DAY_MS),
    to,
    horizonDays,
    minHolders,
    maxMarkets,
  };

  // --- Robustness sweep ----------------------------------------------------
  // A single run cannot tell you whether its own finding is a configuration artefact, so this is
  // the more informative of the two modes. See src/lib/backtest/robustness.ts.
  if (process.argv.includes("--sweep")) {
    console.log(
      `PolyAlpha robustness sweep — horizons ${DEFAULT_HORIZONS.join(", ")}d, lookback ${lookbackDays}d\n`,
    );
    const report = await runRobustnessSweep(prisma, params, DEFAULT_HORIZONS, DEFAULT_SCORING_CONFIG);

    console.log("horizon  signals  win rate  implied     edge   best band     p     rank r");
    for (const h of report.horizons) {
      console.log(
        [
          `${h.horizonDays}d`.padStart(7),
          String(h.signals).padStart(9),
          pct(h.winRate).padStart(9),
          pct(h.impliedWinRate).padStart(9),
          (h.edgePoints === null ? "n/a" : `${h.edgePoints >= 0 ? "+" : ""}${h.edgePoints.toFixed(1)}pp`).padStart(8),
          (h.bestBandLabel ?? "n/a").padStart(11),
          (h.bestBandPValue === null ? "n/a" : h.bestBandPValue.toFixed(3)).padStart(6),
          (h.rankCorrelation === null ? "n/a" : h.rankCorrelation.toFixed(3)).padStart(8),
          h.significantAlone ? "  <- significant alone" : "",
        ].join(" "),
      );
    }

    console.log(`\nVERDICT: ${report.verdict}\n`);
    for (const line of report.narrative) console.log(`  ${line}\n`);

    if (save) {
      const run = await prisma.backtestRun.create({
        data: {
          label: label ?? `Robustness sweep — ${DEFAULT_HORIZONS.join("/")}d horizons`,
          params: {
            kind: "robustness",
            from: params.from.toISOString(),
            to: params.to.toISOString(),
            horizons: DEFAULT_HORIZONS,
            maxMarkets,
          },
          config: JSON.parse(JSON.stringify(DEFAULT_SCORING_CONFIG)),
          results: JSON.parse(JSON.stringify({ kind: "robustness", report })),
          signalCount: 0,
        },
      });
      console.log(`saved as run ${run.id}`);
    }

    await prisma.$disconnect();
    return;
  }

  console.log(
    `PolyAlpha backtest — horizon ${horizonDays}d, lookback ${lookbackDays}d, min holders ${minHolders}\n`,
  );

  const { results, signals } = await runBacktest(prisma, params, DEFAULT_SCORING_CONFIG);

  console.log(
    `markets: ${results.marketsConsidered} considered, ${results.marketsTested} tested, ${results.tradersScored} traders rescored point-in-time`,
  );
  console.log("skipped:", results.skipped);
  console.log(
    `\nsignals ${results.signals}  wins ${results.wins}  losses ${results.losses}`,
  );
  const ci = (interval: { low: number; high: number } | null) =>
    interval === null
      ? ""
      : `  [${(interval.low * 100).toFixed(1)}–${(interval.high * 100).toFixed(1)}%]`;

  console.log(`win rate       ${pct(results.winRate)}${ci(results.winRateInterval)}`);
  console.log(`market implied ${pct(results.impliedWinRate)}   <- the benchmark to beat`);
  console.log(
    `edge           ${results.edgePoints === null ? "     n/a" : `${results.edgePoints >= 0 ? "+" : ""}${results.edgePoints.toFixed(1)}pp`}`,
  );
  console.log(`return per $1  ${pct(results.roi)}`);
  console.log(
    `rank corr.     ${results.rankCorrelation === null ? "     n/a" : results.rankCorrelation.toFixed(3)}`,
  );

  const q = results.priceQuality;
  console.log(
    `\nbenchmark price quality: ${q.bySource.series} from CLOB curve, ${q.bySource.snapshot} from snapshot, ${q.bySource.trade} from last fill`,
  );
  console.log(
    `  age at signal  median ${q.medianAgeHours === null ? "n/a" : `${q.medianAgeHours.toFixed(1)}h`}   p90 ${q.p90AgeHours === null ? "n/a" : `${q.p90AgeHours.toFixed(1)}h`}`,
  );

  if (results.calibration) {
    const c = results.calibration;
    console.log(
      `\nsignificance vs the market's own prices (${c.iterations} simulations, bands need n>=${c.minBucketSize}):`,
    );
    const p = (value: number | null) => (value === null ? "n/a" : value.toFixed(3));
    console.log(`  best band edge   p=${p(c.bestBucketEdgePValue)}`);
    console.log(`  aggregate edge   p=${p(c.overallEdgePValue)}`);
    console.log(`  rank correlation p=${p(c.rankCorrelationPValue)}`);
  }

  console.log("\nscore     n  wins  win rate  implied     edge   return   95% CI on win rate");
  for (const bucket of results.buckets) {
    console.log(
      [
        bucket.label.padEnd(8),
        String(bucket.signals).padStart(4),
        String(bucket.wins).padStart(5),
        pct(bucket.winRate).padStart(9),
        pct(bucket.impliedWinRate).padStart(9),
        (bucket.edgePoints === null
          ? "n/a"
          : `${bucket.edgePoints >= 0 ? "+" : ""}${bucket.edgePoints.toFixed(1)}pp`
        ).padStart(9),
        pct(bucket.roi).padStart(8),
        ci(bucket.winRateInterval),
      ].join(" "),
    );
  }

  for (const warning of results.warnings) console.log(`\n! ${warning}`);

  if (save) {
    const run = await prisma.backtestRun.create({
      data: {
        label: label ?? `${horizonDays}d horizon, ${lookbackDays}d lookback`,
        params: {
          from: params.from.toISOString(),
          to: params.to.toISOString(),
          horizonDays,
          minHolders,
          maxMarkets,
          minPrice: params.minPrice,
          maxPrice: params.maxPrice,
        },
        config: JSON.parse(JSON.stringify(DEFAULT_SCORING_CONFIG)),
        results: JSON.parse(JSON.stringify(results)),
        signalCount: results.signals,
        winRate: results.winRate,
        roi: results.roi,
        maxDrawdown: results.maxDrawdown,
      },
    });

    if (signals.length > 0) {
      await prisma.backtestSignal.createMany({
        data: signals.map((s) => ({
          runId: run.id,
          marketId: s.marketId,
          outcomeIndex: s.outcomeIndex,
          signalAt: s.signalAt,
          priceAtSignal: s.priceAtSignal,
          opportunityScore: s.opportunityScore,
          consensusScore: s.consensusScore,
          qualifiedTraders: s.qualifiedTraders,
          weightedEntry: s.weightedEntry,
          entryGap: s.entryGap,
          resolvedOutcomeIndex: s.won ? s.outcomeIndex : null,
          resolvedAt: s.resolvedAt,
          won: s.won,
          pnlPerDollar: s.pnlPerDollar,
        })),
      });
    }

    console.log(`\nsaved as run ${run.id}`);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
