/**
 * Watchlist seed.
 *
 * These are REAL wallets taken from Polymarket's own `/v1/leaderboard`, not invented addresses —
 * a fabricated address would simply return no data and the dashboard would look broken.
 *
 * Nothing in the product is hardcoded around these specific traders. The watchlist is fully
 * editable: add or remove anyone from the Traders page, and `--discover` re-pulls the current
 * leaderboard.
 *
 *   npm run db:seed                     seed the list below
 *   npm run db:seed -- --discover       also pull the live leaderboard top 25
 *   npm run db:seed -- --discover=100   ...or the top 100
 *   npm run db:seed -- --reset          remove existing traders first
 *
 * Specialties start as UNKNOWN because a wallet's actual specialty is something we measure from
 * its resolved positions, not something to assert up front. The sync fills in the real per-category
 * record, and you can override the label by hand.
 */
import "dotenv/config";
import { Category, PrismaClient, TraderSource } from "@prisma/client";
import { fetchLeaderboard } from "../src/lib/polymarket/data";
import { normalizeWallet } from "../src/lib/polymarket/normalize";
import { SETTINGS_ID } from "../src/lib/settings";

const prisma = new PrismaClient();

interface SeedTrader {
  wallet: string;
  displayName: string;
  specialty: Category;
  notes: string;
}

/** Captured from the live leaderboard. Verified to return real data from the Data API. */
const SEED_TRADERS: SeedTrader[] = [
  {
    wallet: "0x2c335066fe58fe9237c3d3dc7b275c2a034a0563",
    displayName: "Leaderboard #1",
    specialty: Category.UNKNOWN,
    notes:
      "Top of Polymarket's all-time PnL leaderboard with very high volume. High volume relative to profit can indicate market making — check the behaviour classification before weighting this wallet heavily.",
  },
  {
    wallet: "0x3a8aa345d5db7ec5138298c8c4f4540259be7699",
    displayName: "TheReturnOfDarthMaul",
    specialty: Category.UNKNOWN,
    notes: "Very high profit on comparatively low volume, which suggests concentrated directional bets rather than scalping.",
  },
  {
    wallet: "0x7ad71d79a3bb90d0a87a06500fa0fe11663842aa",
    displayName: "theowalcott",
    specialty: Category.UNKNOWN,
    notes: "Top-5 all-time PnL.",
  },
  {
    wallet: "0x6575759174ad221bba9947bc3f18750ec769b198",
    displayName: "dromedaryy",
    specialty: Category.UNKNOWN,
    notes: "Top-5 all-time PnL on low reported volume.",
  },
  {
    wallet: "0x924379a79c64b77ad5816ad362122a5f6228658e",
    displayName: "Kch-Temp",
    specialty: Category.UNKNOWN,
    notes: "Top-10 all-time PnL.",
  },
  {
    wallet: "0xc8ab97a9089a9ff7e6ef0688e6e591a066946418",
    displayName: "ArmageddonRewardsBilly",
    specialty: Category.UNKNOWN,
    notes: "Publicly linked X account (@Eltonma), so positions are somewhat attributable.",
  },
  {
    wallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
    displayName: "RN1",
    specialty: Category.UNKNOWN,
    notes:
      "Publicly linked X account (@RN1polymarket). Very high volume against moderate profit — watch the behaviour classification.",
  },
  {
    wallet: "0xf0318c32136c2db7fec88b84869aee6a1106c80c",
    displayName: "BreakTheBank",
    specialty: Category.UNKNOWN,
    notes: "Strong profit on modest volume.",
  },
  {
    wallet: "0x55a1f55fb021eb52f5233321f88ff8eca5aedb28",
    displayName: "vjnn",
    specialty: Category.UNKNOWN,
    notes: "Top-10 all-time PnL.",
  },
  {
    wallet: "0x8e74984fb998be82444627906740dc1a19c35972",
    displayName: "itwillallbeok",
    specialty: Category.UNKNOWN,
    notes: "Consistent profit across a moderate volume base.",
  },
  {
    wallet: "0x30c7ac0158499ddc6761047f7f69bcf7d036ac3b",
    displayName: "Wiretransferxyz",
    specialty: Category.UNKNOWN,
    notes: "Top-15 all-time PnL.",
  },
  {
    wallet: "0x8c0b024c17831a0dde038547b7e791ae6a0d7aa5",
    displayName: "THEHIGHLIFE",
    specialty: Category.UNKNOWN,
    notes: "Top-15 all-time PnL.",
  },
];

async function upsertTrader(trader: SeedTrader, source: TraderSource) {
  const wallet = normalizeWallet(trader.wallet);
  return prisma.trader.upsert({
    where: { wallet },
    create: {
      wallet,
      displayName: trader.displayName,
      specialty: trader.specialty,
      notes: trader.notes,
      profileUrl: `https://polymarket.com/profile/${wallet}`,
      source,
      active: true,
    },
    // Do not clobber edits made in the UI; only backfill what is missing.
    update: { profileUrl: `https://polymarket.com/profile/${wallet}` },
  });
}

async function main() {
  // `--discover` takes the top 25; `--discover=100` takes the top 100. A wider watchlist is what
  // makes consensus meaningful — with only a handful of wallets, few markets have two of them
  // agreeing, and the Opportunities list stays almost empty.
  const discoverArg = process.argv.find((a) => a === "--discover" || a.startsWith("--discover="));
  const discover = discoverArg !== undefined;
  const discoverCount = (() => {
    if (!discoverArg?.includes("=")) return 25;
    const parsed = Number.parseInt(discoverArg.split("=")[1] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 25;
  })();
  const reset = process.argv.includes("--reset");

  if (reset) {
    const deleted = await prisma.trader.deleteMany({});
    console.log(`Removed ${deleted.count} existing traders.`);
  }

  await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });
  console.log("Settings row ready.");

  let seeded = 0;
  for (const trader of SEED_TRADERS) {
    await upsertTrader(trader, TraderSource.SEED);
    seeded++;
  }
  console.log(`Seeded ${seeded} traders from the captured leaderboard.`);

  if (discover) {
    console.log(`Pulling the current leaderboard (top ${discoverCount})…`);
    const leaderboard = await fetchLeaderboard(discoverCount);
    let added = 0;
    for (const entry of leaderboard) {
      if (!entry.proxyWallet) continue;
      const wallet = normalizeWallet(entry.proxyWallet);
      const existing = await prisma.trader.findUnique({ where: { wallet } });
      if (existing) continue;

      // The leaderboard uses the raw address as a username when no profile name is set.
      const name =
        entry.userName && !entry.userName.toLowerCase().startsWith("0x")
          ? entry.userName
          : `Leaderboard #${entry.rank}`;

      await upsertTrader(
        {
          wallet,
          displayName: name,
          specialty: Category.UNKNOWN,
          notes: `Discovered from the Polymarket leaderboard at rank ${entry.rank}. Reported PnL $${Math.round(entry.pnl ?? 0).toLocaleString("en-US")} on $${Math.round(entry.vol ?? 0).toLocaleString("en-US")} volume. Note: the leaderboard's window parameter has no effect, so these figures are all-time.`,
        },
        TraderSource.LEADERBOARD,
      );
      added++;
    }
    console.log(`Added ${added} newly discovered traders.`);
  }

  const total = await prisma.trader.count();
  console.log(`\nWatchlist now has ${total} traders. Run \`npm run sync\` to pull their data.\n`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
