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

async function main() {
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
