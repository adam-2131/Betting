/**
 * Local sync runner.
 *
 *   npm run sync                      default stages
 *   npm run sync -- --only=prices     one or more stages, comma separated
 *   npm run sync -- --only=all        every stage, including the slow price backfill
 *   npm run sync -- --traders=10      cap traders synced this pass
 *   npm run sync -- --markets=200     cap events pulled this pass
 */
import "dotenv/config";
import { ALL_STAGES, EVERY_STAGE, runSync, type SyncStage } from "../src/lib/sync";
import { prisma } from "../src/lib/db";

function arg(name: string): string | undefined {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match?.split("=")[1];
}

const KNOWN_FLAGS = ["only", "traders", "markets"] as const;

const USAGE = `
PolyAlpha sync

  npm run sync                             default stages: ${ALL_STAGES.join(", ")}
  npm run sync -- --only=opportunities     one or more stages, comma separated
  npm run sync -- --only=all               every stage: ${EVERY_STAGE.join(", ")}
  npm run sync -- --markets=300            cap events pulled this pass
  npm run sync -- --traders=50             cap traders synced this pass
  npm run sync -- --help                   this message
`;

/**
 * Refuse to run on an argument we do not recognise.
 *
 * Without this, anything unrecognised — including `--help` — silently fell through to the default
 * full pass, which now walks thousands of wallets. Asking a question and being given a long
 * network job instead of an answer is a bad trade, and a mistyped flag should not cost an hour.
 */
function checkArgs(): void {
  const passed = process.argv.slice(2).filter((a) => a.startsWith("-"));

  if (passed.some((a) => a === "--help" || a === "-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const unknown = passed.filter((a) => {
    const name = a.replace(/^--?/, "").split("=")[0];
    return !KNOWN_FLAGS.includes(name as (typeof KNOWN_FLAGS)[number]);
  });

  if (unknown.length > 0) {
    console.error(`\nUnrecognised: ${unknown.join(", ")}${USAGE}`);
    process.exit(1);
  }

  // `--only` without a value would otherwise read as absent and run everything.
  const valueless = passed.filter(
    (a) => !a.includes("=") && KNOWN_FLAGS.includes(a.replace(/^--?/, "") as (typeof KNOWN_FLAGS)[number]),
  );
  if (valueless.length > 0) {
    console.error(`\n${valueless.join(", ")} needs a value, e.g. --only=opportunities${USAGE}`);
    process.exit(1);
  }
}

async function main() {
  checkArgs();

  const only = arg("only");
  const stages: SyncStage[] =
    only === "all"
      ? EVERY_STAGE
      : only
        ? (only.split(",").map((s) => s.trim()) as SyncStage[]).filter((s) =>
            EVERY_STAGE.includes(s),
          )
        : ALL_STAGES;

  if (stages.length === 0) {
    console.error(`No valid stages. Choose from: ${EVERY_STAGE.join(", ")}, or "all".`);
    process.exit(1);
  }

  const traderLimit = arg("traders") ? Number(arg("traders")) : undefined;
  const marketLimit = arg("markets") ? Number(arg("markets")) : undefined;

  console.log(`\nPolyAlpha sync — stages: ${stages.join(" → ")}\n`);

  const result = await runSync(stages, { traderLimit, marketLimit });

  for (const stage of result.stages) {
    const status = stage.ok ? "ok  " : "FAIL";
    console.log(`[${status}] ${stage.stage.padEnd(14)} ${(stage.durationMs / 1000).toFixed(1)}s`);
    if (stage.stats) console.log(`         ${JSON.stringify(stage.stats)}`);
    if (stage.error) console.log(`         ${stage.error}`);
  }

  console.log(
    `\n${result.ok ? "Sync complete" : "Sync finished with errors"} in ${(result.durationMs / 1000).toFixed(1)}s\n`,
  );

  await prisma.$disconnect();
  process.exit(result.ok ? 0 : 1);
}

main().catch(async (error) => {
  console.error("Sync failed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
