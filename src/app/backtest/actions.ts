"use server";

/**
 * Runs a backtest and stores it.
 *
 * The scoring config is snapshotted into the run so that changing weights later does not silently
 * rewrite what an old run concluded.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DEFAULT_BACKTEST_PARAMS, runBacktest } from "@/lib/backtest/engine";
import { DEFAULT_HORIZONS, runRobustnessSweep } from "@/lib/backtest/robustness";
import { DEFAULT_SCORING_CONFIG } from "@/lib/scoring/config";

const DAY_MS = 86_400_000;

const schema = z.object({
  lookbackDays: z.coerce.number().int().min(7).max(720),
  horizonDays: z.coerce.number().int().min(1).max(90),
  minHolders: z.coerce.number().int().min(1).max(20),
  maxMarkets: z.coerce.number().int().min(10).max(2000),
  label: z.string().trim().max(80).optional(),
});

export type BacktestActionResult = { ok: boolean; message: string; runId?: string };

export async function runBacktestAction(
  _prev: BacktestActionResult | null,
  formData: FormData,
): Promise<BacktestActionResult> {
  const parsed = schema.safeParse({
    lookbackDays: formData.get("lookbackDays"),
    horizonDays: formData.get("horizonDays"),
    minHolders: formData.get("minHolders"),
    maxMarkets: formData.get("maxMarkets"),
    label: formData.get("label") ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Those inputs are not valid." };
  }

  const { lookbackDays, horizonDays, minHolders, maxMarkets, label } = parsed.data;
  const to = new Date();
  const params = {
    ...DEFAULT_BACKTEST_PARAMS,
    from: new Date(to.getTime() - lookbackDays * DAY_MS),
    to,
    horizonDays,
    minHolders,
    maxMarkets,
  };

  try {
    const { results, signals } = await runBacktest(prisma, params, DEFAULT_SCORING_CONFIG);

    const run = await prisma.backtestRun.create({
      data: {
        label: label && label.length > 0 ? label : null,
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

    revalidatePath("/backtest");
    return {
      ok: true,
      runId: run.id,
      message:
        results.signals === 0
          ? "The run completed but reconstructed no signals. See the skip counts below."
          : `Reconstructed ${results.signals} historical signals across ${results.marketsTested} markets.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The backtest failed.",
    };
  }
}

export async function deleteBacktestRun(runId: string): Promise<void> {
  await prisma.backtestRun.delete({ where: { id: runId } });
  revalidatePath("/backtest");
}

const sweepSchema = z.object({
  lookbackDays: z.coerce.number().int().min(7).max(720),
  maxMarkets: z.coerce.number().int().min(10).max(4000),
});

/**
 * Runs the same analysis across several signal horizons.
 *
 * Stored as a `BacktestRun` whose `results` carries `kind: "robustness"`, so it lives alongside
 * single runs without a schema change. `signalCount` stays 0 because a sweep has no single signal
 * set of its own.
 */
export async function runSweepAction(
  _prev: BacktestActionResult | null,
  formData: FormData,
): Promise<BacktestActionResult> {
  const parsed = sweepSchema.safeParse({
    lookbackDays: formData.get("lookbackDays"),
    maxMarkets: formData.get("maxMarkets"),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Those inputs are not valid." };
  }

  const to = new Date();
  const base = {
    ...DEFAULT_BACKTEST_PARAMS,
    from: new Date(to.getTime() - parsed.data.lookbackDays * DAY_MS),
    to,
    maxMarkets: parsed.data.maxMarkets,
  };

  try {
    const report = await runRobustnessSweep(prisma, base, DEFAULT_HORIZONS, DEFAULT_SCORING_CONFIG);

    const run = await prisma.backtestRun.create({
      data: {
        label: `Robustness sweep — ${DEFAULT_HORIZONS.join("/")}d horizons`,
        params: {
          kind: "robustness",
          from: base.from.toISOString(),
          to: base.to.toISOString(),
          horizons: DEFAULT_HORIZONS,
          maxMarkets: parsed.data.maxMarkets,
        },
        config: JSON.parse(JSON.stringify(DEFAULT_SCORING_CONFIG)),
        results: JSON.parse(JSON.stringify({ kind: "robustness", report })),
        signalCount: 0,
      },
    });

    revalidatePath("/backtest");
    return { ok: true, runId: run.id, message: `Sweep complete: ${report.verdict}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The sweep failed." };
  }
}
