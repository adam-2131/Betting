import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const [watchlist, synced, opportunities, sportsGames] = await Promise.all([
    prisma.trader.count({ where: { active: true } }),
    prisma.trader.count({ where: { lastSyncedAt: { not: null } } }),
    prisma.opportunity.count(),
    prisma.opportunity.count({ where: { gamePhase: { not: null } } }),
  ]);
  const lastRuns = await prisma.syncRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 4,
    select: { stage: true, startedAt: true, finishedAt: true, ok: true },
  });
  console.log({ watchlist, synced, opportunities, sportsGames });
  for (const r of lastRuns) {
    console.log(
      `  ${r.stage.padEnd(14)} ${r.finishedAt ? (r.ok ? "ok" : "FAILED") : "running…"}  started ${r.startedAt.toISOString().slice(11, 19)}`,
    );
  }
  await prisma.$disconnect();
}

main();
