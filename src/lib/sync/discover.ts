/**
 * TRADER DISCOVERY FROM MARKET HOLDERS
 *
 * The watchlist's selection bias is the one limitation the backtest cannot engineer away. Every
 * wallet on it arrived via `/v1/leaderboard`, which ranks by all-time realised profit — so the
 * watchlist is, by construction, a list of wallets that already won. Replaying their trades and
 * finding that the trades did well proves very little: the selection did the work.
 *
 * This stage discovers wallets a different way. It picks markets by trading volume, then takes
 * whoever was holding them. Volume is a property of the market, not of the wallet's record, so
 * the resulting sample is chosen without reference to whether anyone made money. A wallet that
 * lost heavily is exactly as likely to appear as one that won.
 *
 * WHAT THIS DOES NOT FIX. `/holders` returns the LARGEST holders, so the sample is still biased
 * toward size — big wallets, not necessarily good ones. That is a materially weaker bias than
 * selecting on profit (being large does not imply having been right) but it is not neutral
 * sampling, and the honest description of the watchlist afterwards is "leaderboard winners plus
 * large holders of busy markets", not "a random sample of traders".
 *
 * Discovered wallets are recorded with `TraderSource.HOLDERS` so the backtest and the UI can tell
 * the two populations apart.
 */
import { Category, TraderSource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { fetchHolders, fetchTrades } from "@/lib/polymarket/data";
import { normalizeWallet } from "@/lib/polymarket/normalize";
import { safeNumber } from "@/lib/num";

export interface DiscoverStats {
  marketsSampled: number;
  holdersSeen: number;
  uniqueWallets: number;
  alreadyTracked: number;
  belowThreshold: number;
  added: number;
}

export interface DiscoverOptions {
  /** How many markets to sample holders from. */
  marketSample?: number;
  /** Holders requested per market (the API returns largest first). */
  holdersPerMarket?: number;
  /** Ignore holdings smaller than this many shares — dust and airdrop noise. */
  minShares?: number;
  /** A wallet must appear in at least this many sampled markets to be added. */
  minMarketsHeld?: number;
  /** Cap on new traders added in one run. */
  maxNewTraders?: number;
}

/**
 * Samples holders of high-volume markets and adds the recurring ones to the watchlist.
 *
 * The `minMarketsHeld` filter is what keeps this useful rather than noisy: appearing in one
 * market's top holders can just mean one large bet, while appearing in several means the wallet
 * trades regularly and will actually produce signals worth scoring.
 */
export async function discoverFromHolders(options: DiscoverOptions = {}): Promise<DiscoverStats> {
  const {
    marketSample = 300,
    holdersPerMarket = 40,
    minShares = 100,
    minMarketsHeld = 2,
    maxNewTraders = 400,
  } = options;

  const stats: DiscoverStats = {
    marketsSampled: 0,
    holdersSeen: 0,
    uniqueWallets: 0,
    alreadyTracked: 0,
    belowThreshold: 0,
    added: 0,
  };

  // Busy markets, chosen by volume rather than by anything about their holders. Both open and
  // resolved markets qualify: restricting to resolved ones would quietly bias toward wallets that
  // hold to settlement rather than trading in and out.
  const markets = await prisma.market.findMany({
    where: { volume: { gt: 0 } },
    orderBy: { volume: "desc" },
    take: marketSample,
    select: { conditionId: true, category: true },
  });

  if (markets.length === 0) return stats;

  const seen = new Map<string, { markets: number; shares: number; name: string | null; categories: Category[] }>();

  for (const market of markets) {
    stats.marketsSampled++;

    let responses;
    try {
      responses = await fetchHolders(market.conditionId, holdersPerMarket);
    } catch {
      // A single failed market must not abandon the sweep; the stage is safe to re-run.
      continue;
    }

    // One wallet can hold both sides of the same market. Count the market once regardless.
    const walletsThisMarket = new Set<string>();

    for (const response of responses) {
      for (const holder of response.holders ?? []) {
        if (!holder.proxyWallet) continue;
        stats.holdersSeen++;

        const shares = typeof holder.amount === "number" && Number.isFinite(holder.amount) ? holder.amount : 0;
        if (shares < minShares) continue;

        const wallet = normalizeWallet(holder.proxyWallet);
        if (!wallet) continue;

        const entry = seen.get(wallet) ?? { markets: 0, shares: 0, name: null, categories: [] };
        if (!walletsThisMarket.has(wallet)) {
          entry.markets++;
          entry.categories.push(market.category);
          walletsThisMarket.add(wallet);
        }
        entry.shares += shares;
        // `name` is only meaningful when the profile is public; pseudonyms are auto-generated.
        if (!entry.name && holder.displayUsernamePublic && holder.name) entry.name = holder.name;
        seen.set(wallet, entry);
      }
    }
  }

  stats.uniqueWallets = seen.size;
  if (seen.size === 0) return stats;

  const wallets = [...seen.keys()];
  const tracked = new Set<string>();
  for (let i = 0; i < wallets.length; i += 500) {
    const rows = await prisma.trader.findMany({
      where: { wallet: { in: wallets.slice(i, i + 500) } },
      select: { wallet: true },
    });
    for (const row of rows) tracked.add(row.wallet);
  }

  const candidates = [...seen.entries()]
    .filter(([wallet, entry]) => {
      if (tracked.has(wallet)) {
        stats.alreadyTracked++;
        return false;
      }
      if (entry.markets < minMarketsHeld) {
        stats.belowThreshold++;
        return false;
      }
      return true;
    })
    // Most active first, so a maxNewTraders cap keeps the wallets likeliest to produce signals.
    .sort((a, b) => b[1].markets - a[1].markets || b[1].shares - a[1].shares)
    .slice(0, maxNewTraders);

  if (candidates.length === 0) return stats;

  await prisma.trader.createMany({
    data: candidates.map(([wallet, entry]) => ({
      wallet,
      displayName: entry.name ?? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
      specialty: dominantCategory(entry.categories),
      source: TraderSource.HOLDERS,
      notes: `Discovered as a top holder in ${entry.markets} of the ${stats.marketsSampled} highest-volume markets sampled. Selected on market volume rather than on this wallet's results, so unlike a leaderboard entry it carries no implication that the wallet has been profitable.`,
    })),
    skipDuplicates: true,
  });

  stats.added = candidates.length;
  return stats;
}

// ---------------------------------------------------------------------------
// Discovery from the trade tape
// ---------------------------------------------------------------------------

export interface TapeDiscoverStats {
  tradesScanned: number;
  uniqueWallets: number;
  alreadyTracked: number;
  belowThreshold: number;
  added: number;
}

export interface TapeDiscoverOptions {
  /** How many recent trades to walk. The endpoint pages by offset. */
  maxTrades?: number;
  /** Page size per request. */
  pageSize?: number;
  /** Ignore fills below this notional — dust and rounding. */
  minTradeUsd?: number;
  /** A wallet must appear in at least this many DISTINCT markets to be added. */
  minMarketsTraded?: number;
  maxNewTraders?: number;
}

/**
 * Discovers wallets from the global trade tape.
 *
 * This exists because the other two sources share a blind spot. `/v1/leaderboard` ranks by
 * all-time realised profit, so it returns wallets that already won. `/holders` returns the LARGEST
 * holders, so it returns wallets that are big. Neither returns a wallet that is simply trading a
 * lot right now, and for short-horizon and sports markets that is exactly the population worth
 * watching: whoever is active in a market resolving this week is expressing a view about this
 * week, while a large holder may have taken their position months ago and forgotten it.
 *
 * The tape has its own bias, in the opposite direction: it over-samples HIGH-FREQUENCY wallets, so
 * market makers and bots surface first. That is not fatal — the behaviour classifier already
 * identifies and down-weights them downstream, and `excludeBots` can drop them entirely — but it
 * does mean the raw tape is not a neutral sample either. Requiring a wallet to appear across
 * several DISTINCT markets rather than merely many times filters the single-market grinders.
 *
 * Taken together the three sources give a watchlist that is "leaderboard winners, large holders,
 * and currently-active traders". That is broader than any one of them and still not neutral, and
 * `TraderSource` records which door each wallet came through so the difference stays visible.
 */
export async function discoverFromTape(
  options: TapeDiscoverOptions = {},
): Promise<TapeDiscoverStats> {
  const {
    maxTrades = 4000,
    pageSize = 500,
    minTradeUsd = 50,
    minMarketsTraded = 2,
    maxNewTraders = 300,
  } = options;

  const stats: TapeDiscoverStats = {
    tradesScanned: 0,
    uniqueWallets: 0,
    alreadyTracked: 0,
    belowThreshold: 0,
    added: 0,
  };

  const seen = new Map<
    string,
    { markets: Set<string>; notional: number; name: string | null }
  >();

  for (let offset = 0; offset < maxTrades; offset += pageSize) {
    let page;
    try {
      page = await fetchTrades({ limit: pageSize, offset });
    } catch {
      // A failed page must not abandon the sweep; the stage is safe to re-run.
      break;
    }
    if (page.length === 0) break;

    for (const trade of page) {
      stats.tradesScanned++;
      if (!trade.proxyWallet || !trade.conditionId) continue;

      const size = safeNumber(trade.size) ?? 0;
      const price = safeNumber(trade.price) ?? 0;
      const notional = size * price;
      if (notional < minTradeUsd) continue;

      const wallet = normalizeWallet(trade.proxyWallet);
      if (!wallet) continue;

      const entry = seen.get(wallet) ?? { markets: new Set<string>(), notional: 0, name: null };
      entry.markets.add(trade.conditionId);
      entry.notional += notional;
      if (!entry.name && trade.name) entry.name = trade.name;
      seen.set(wallet, entry);
    }

    if (page.length < pageSize) break;
  }

  stats.uniqueWallets = seen.size;
  if (seen.size === 0) return stats;

  const wallets = [...seen.keys()];
  const tracked = new Set<string>();
  for (let i = 0; i < wallets.length; i += 500) {
    const rows = await prisma.trader.findMany({
      where: { wallet: { in: wallets.slice(i, i + 500) } },
      select: { wallet: true },
    });
    for (const row of rows) tracked.add(row.wallet);
  }

  const candidates = [...seen.entries()]
    .filter(([wallet, entry]) => {
      if (tracked.has(wallet)) {
        stats.alreadyTracked++;
        return false;
      }
      if (entry.markets.size < minMarketsTraded) {
        stats.belowThreshold++;
        return false;
      }
      return true;
    })
    // Breadth first, then size. A wallet across many markets is more useful than one that
    // happened to push a lot of notional through a single market.
    .sort((a, b) => b[1].markets.size - a[1].markets.size || b[1].notional - a[1].notional)
    .slice(0, maxNewTraders);

  if (candidates.length === 0) return stats;

  await prisma.trader.createMany({
    data: candidates.map(([wallet, entry]) => ({
      wallet,
      displayName: entry.name ?? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
      specialty: Category.UNKNOWN,
      source: TraderSource.HOLDERS,
      notes: `Discovered on the live trade tape, active across ${entry.markets.size} distinct markets in the window sampled. Selected on recent activity rather than on profit or position size, so this wallet carries no implication of having been either successful or large. The tape over-represents high-frequency wallets, so this one may turn out to be automated.`,
    })),
    skipDuplicates: true,
  });

  stats.added = candidates.length;
  return stats;
}

/** The category the wallet showed up in most. Ties fall back to UNKNOWN rather than guessing. */
function dominantCategory(categories: Category[]): Category {
  if (categories.length === 0) return Category.UNKNOWN;

  const counts = new Map<Category, number>();
  for (const category of categories) {
    if (category === Category.UNKNOWN) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (counts.size === 0) return Category.UNKNOWN;

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return Category.UNKNOWN;
  return ranked[0][0];
}
