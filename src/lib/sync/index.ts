/**
 * Sync orchestration.
 *
 * Stages run in dependency order: markets, then traders, then scores, then opportunities. Each
 * stage records a `SyncRun` row so failures are visible in the UI rather than silent.
 *
 * Two entry points, one implementation:
 *   npm run sync            (scripts/sync.ts)
 *   POST /api/cron/sync     (guarded by CRON_SECRET)
 */
import { prisma } from "@/lib/db";
import { pruneFeed } from "./feed";
import { refreshStaleTrackedMarkets, syncMarkets } from "./markets";
import { syncOpportunities } from "./opportunities";
import { discoverFromHolders, discoverFromTape } from "./discover";
import { syncPriceHistory } from "./prices";
import { relinkOrphans } from "./relink";
import { syncScores } from "./scores";
import { syncTraders } from "./traders";

export type SyncStage =
  | "markets"
  | "discover"
  | "traders"
  | "relink"
  | "prices"
  | "scores"
  | "opportunities";

/**
 * `relink` sits after `traders` because it repairs rows the trader stage has just written, using
 * markets the same stage has just discovered. It makes no network calls.
 *
 * `prices` follows `relink` because it only backfills markets that tracked traders touched, and
 * relink is what attaches that activity to its market. It is excluded from the default set: it is
 * slow, only the backtest reads it, and nothing in the live dashboard depends on it.
 */
export const ALL_STAGES: SyncStage[] = [
  "markets",
  "traders",
  "relink",
  "scores",
  "opportunities",
];

/**
 * Every stage including the optional ones. `npm run sync -- --only=all` uses this.
 *
 * `discover` sits between `markets` and `traders`: it samples holders of the markets the first
 * stage just refreshed, and the wallets it adds are then synced by the second. It is optional
 * because it widens the watchlist, which is a deliberate choice rather than routine upkeep.
 */
export const EVERY_STAGE: SyncStage[] = [
  "markets",
  "discover",
  "traders",
  "relink",
  "prices",
  "scores",
  "opportunities",
];

export interface StageResult {
  stage: SyncStage;
  ok: boolean;
  durationMs: number;
  stats?: unknown;
  error?: string;
}

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stages: StageResult[];
  ok: boolean;
}

async function runStage(stage: SyncStage, fn: () => Promise<unknown>): Promise<StageResult> {
  const started = Date.now();
  const run = await prisma.syncRun.create({ data: { stage } });

  try {
    const stats = await fn();
    const durationMs = Date.now() - started;
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: true, stats: (stats ?? {}) as object },
    });
    return { stage, ok: true, durationMs, stats };
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, error: message.slice(0, 2000) },
    });
    return { stage, ok: false, durationMs, error: message };
  }
}

export async function runSync(
  stages: SyncStage[] = ALL_STAGES,
  options: { marketLimit?: number; traderLimit?: number } = {},
): Promise<SyncResult> {
  const startedAt = new Date();
  const results: StageResult[] = [];

  for (const stage of stages) {
    switch (stage) {
      case "markets":
        results.push(
          await runStage("markets", async () => {
            const stats = await syncMarkets({ limit: options.marketLimit });
            const refreshed = await refreshStaleTrackedMarkets();
            return { ...stats, staleTrackedRefreshed: refreshed };
          }),
        );
        break;

      case "traders":
        results.push(
          await runStage("traders", async () => {
            const summary = await syncTraders({ limit: options.traderLimit });
            const perTrader = summary.results;
            return {
              // Both numbers matter now that the watchlist can be far larger than one pass:
              // `traders` is what was refreshed, `watchlistSize` is what is being tracked.
              traders: perTrader.length,
              watchlistSize: summary.watchlistSize,
              byTier: summary.byTier,
              deferred: summary.deferred,
              notDue: summary.notDue,
              positions: perTrader.reduce((acc, t) => acc + t.positions, 0),
              closedPositions: perTrader.reduce((acc, t) => acc + t.closedPositions, 0),
              closedUnchanged: perTrader.reduce((acc, t) => acc + t.closedPositionsUnchanged, 0),
              activityRows: perTrader.reduce((acc, t) => acc + t.activityRows, 0),
              failures: perTrader.filter((t) => t.error).map((t) => ({ wallet: t.wallet, error: t.error })),
            };
          }),
        );
        break;

      case "discover":
        results.push(
          await runStage("discover", async () => {
            // Two sources with opposite biases. Holders over-samples LARGE wallets, the tape
            // over-samples ACTIVE ones. Running both widens the watchlist in two directions
            // instead of deepening one of them.
            const holders = await discoverFromHolders();
            const tape = await discoverFromTape();
            return { holders, tape, added: holders.added + tape.added };
          }),
        );
        break;

      case "prices":
        results.push(await runStage("prices", () => syncPriceHistory()));
        break;

      case "relink":
        results.push(await runStage("relink", () => relinkOrphans()));
        break;

      case "scores":
        results.push(await runStage("scores", () => syncScores()));
        break;

      case "opportunities":
        results.push(
          await runStage("opportunities", async () => {
            const stats = await syncOpportunities();
            const pruned = await pruneFeed();
            return { ...stats, feedEventsPruned: pruned };
          }),
        );
        break;
    }
  }

  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    stages: results,
    ok: results.every((r) => r.ok),
  };
}

export async function getLastSyncRuns(limit = 12) {
  return prisma.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: limit });
}
