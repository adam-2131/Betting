/**
 * One-off: point the bet log at your own Polymarket wallet and pull your history in.
 *
 *   npm run setup:wallet -- 0xYourProxyWallet
 *
 * The same thing the Settings page does, from the command line, so a fresh deployment can be set
 * up before the site is even reachable.
 *
 * NAMING TRAP worth knowing: Polymarket trades from a PROXY wallet, which is not the MetaMask
 * address you signed up with. The proxy is the one in your profile URL —
 * polymarket.com/profile/0x… — and it is the only one the Data API answers for. Pass the wrong one
 * and every endpoint returns empty with no error, so this checks for activity and says so.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { ETH_ADDRESS_PATTERN, normalizeWallet } from "../src/lib/polymarket/normalize";
import { fetchPortfolioValue, fetchTradedCount } from "../src/lib/polymarket/data";
import { importWalletBets } from "../src/lib/bets/import-wallet";

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("\nUsage: npm run setup:wallet -- 0xYourProxyWallet\n");
    process.exit(1);
  }

  const wallet = normalizeWallet(raw);
  if (!ETH_ADDRESS_PATTERN.test(wallet)) {
    console.error(`\n"${raw}" is not a wallet address. It should start 0x and be 42 characters.\n`);
    process.exit(1);
  }

  console.log(`\nChecking ${wallet.slice(0, 10)}… against Polymarket…`);
  const [value, traded] = await Promise.all([
    fetchPortfolioValue(wallet),
    fetchTradedCount(wallet),
  ]);

  if (traded === null || traded === 0) {
    console.error("\nThat address has never traded on Polymarket.");
    console.error("Polymarket trades from a PROXY wallet, not the address you signed in with.");
    console.error("Open your profile on polymarket.com — the 0x… in the URL is the one to use.\n");
    process.exit(1);
  }

  console.log(`  portfolio value: $${(value ?? 0).toFixed(2)}`);
  console.log(`  markets traded:  ${traded}`);

  await prisma.appSettings.upsert({
    where: { id: "default" },
    create: { id: "default", myWallet: wallet },
    update: { myWallet: wallet },
  });
  console.log("\nSaved. Importing your bets…");

  const stats = await importWalletBets();
  console.log(
    `  ${stats.imported} imported, ${stats.duplicates} already known, ${stats.settled} settled` +
      `${stats.unlinked > 0 ? `, ${stats.unlinked} skipped (market not resolvable)` : ""}`,
  );

  const total = await prisma.betLog.count();
  console.log(`\nYour log now holds ${total} bet${total === 1 ? "" : "s"}. Open /bets to see it.`);
  console.log("Closing prices fill in automatically on the next sync.\n");

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("\nFailed:", error instanceof Error ? error.message : error, "\n");
  await prisma.$disconnect();
  process.exit(1);
});
