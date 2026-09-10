/**
 * Keeps the database current without anyone remembering to run a sync.
 *
 *   npm run auto                       every 10 minutes, default stages
 *   npm run auto -- --minutes=5        tighter loop
 *   npm run auto -- --full-every=6     every 6th pass also runs the slow optional stages
 *   npm run auto -- --only=markets,opportunities   fix the stage list, never widen it
 *
 * Why a loop rather than a scheduler. The cron route exists for a deployed instance, but this is
 * a local tool started by hand, and Windows Task Scheduler entries are easy to create and then
 * forget about. A foreground process next to `npm run dev` is visible: when the terminal is
 * closed, syncing stops, which is the behaviour that matches how the rest of this app is run.
 *
 * Design notes:
 *   - A failed pass is logged and the loop continues. Polymarket returning 502 for a minute must
 *     not require restarting the process.
 *   - The interval is measured from the END of a pass, so a slow sync can never stack up behind
 *     itself and open a second set of connections.
 *   - `discover` and `prices` are expensive and only matter occasionally, so they run on a
 *     multiple of the base interval rather than every pass.
 */
import "dotenv/config";
import { ALL_STAGES, EVERY_STAGE, runSync, type SyncStage } from "../src/lib/sync";
import { prisma } from "../src/lib/db";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MINUTES = positiveNumber(arg("minutes"), 10);
const FULL_EVERY = Math.max(1, Math.round(positiveNumber(arg("full-every"), 6)));

/** An explicit `--only` pins every pass to that list; the full/standard alternation is skipped. */
const ONLY: SyncStage[] | null = (() => {
  const raw = arg("only");
  if (!raw) return null;
  const stages = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SyncStage => (EVERY_STAGE as readonly string[]).includes(s));
  if (stages.length === 0) {
    console.error(`No valid stages in --only. Choose from: ${EVERY_STAGE.join(", ")}`);
    process.exit(1);
  }
  return stages;
})();

function stamp(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n[${stamp()}] stopping after the current pass…`);
  });
}

async function main() {
  console.log(
    ONLY
      ? `\nPolyAlpha auto-sync — every ${MINUTES} min, fixed stages: ${ONLY.join(" → ")}. Ctrl+C to stop.\n`
      : `\nPolyAlpha auto-sync — every ${MINUTES} min, full pass every ${FULL_EVERY}${FULL_EVERY === 1 ? "" : "th"}. Ctrl+C to stop.\n`,
  );

  let pass = 0;

  while (!stopping) {
    pass++;
    const full = ONLY === null && (pass % FULL_EVERY === 1 || FULL_EVERY === 1);
    const stages: SyncStage[] = ONLY ?? (full ? EVERY_STAGE : ALL_STAGES);
    const started = Date.now();

    console.log(
      `[${stamp()}] pass ${pass} (${ONLY ? "fixed" : full ? "full" : "standard"}): ${stages.join(" → ")}`,
    );

    try {
      const result = await runSync(stages);
      for (const stage of result.stages) {
        const status = stage.ok ? "ok  " : "FAIL";
        console.log(
          `           [${status}] ${stage.stage.padEnd(14)} ${(stage.durationMs / 1000).toFixed(1)}s${
            stage.error ? `  ${stage.error.slice(0, 160)}` : ""
          }`,
        );
      }
      console.log(
        `[${stamp()}] pass ${pass} ${result.ok ? "complete" : "completed with failures"} in ${(
          (Date.now() - started) / 1000
        ).toFixed(1)}s`,
      );
    } catch (error) {
      // Never exit the loop on a transient upstream failure.
      console.error(
        `[${stamp()}] pass ${pass} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (stopping) break;

    console.log(`[${stamp()}] next pass in ${MINUTES} min\n`);
    // Wake up often enough that Ctrl+C feels responsive during a long wait.
    const wakeAt = Date.now() + MINUTES * 60_000;
    while (!stopping && Date.now() < wakeAt) await sleep(1000);
  }

  await prisma.$disconnect();
  console.log(`[${stamp()}] auto-sync stopped.`);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
