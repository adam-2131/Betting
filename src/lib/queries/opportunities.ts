/**
 * Read-side queries for the Opportunities and Smart Money screens.
 *
 * The sync writes rows; this reads them. Soft filters (score floors, liquidity, spread, category)
 * are applied here rather than at write time so changing a setting takes effect immediately
 * instead of requiring a resync. The hard eligibility gate — a side must have a qualified trader
 * at a tradeable price — is applied by the sync, because a row failing it is not an opportunity
 * at any filter setting.
 */
import type { Category, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";

export interface OpportunityFilters {
  categories?: Category[];
  minScore?: number;
  minConsensus?: number;
  minTraderScore?: number;
  minLiquidity?: number;
  maxSpread?: number;
  minAgreeingTraders?: number;
  /** Maximum acceptable gap between current price and weighted smart-money entry, in cents. */
  maxEntryGapCents?: number;
  /** Only markets resolving within this many hours. */
  resolvesWithinHours?: number;
  excludeBots?: boolean;
  limit?: number;
}

const opportunityInclude = {
  signals: { orderBy: { type: "asc" } },
  market: {
    select: {
      id: true,
      conditionId: true,
      question: true,
      slug: true,
      eventSlug: true,
      category: true,
      outcomes: true,
      endDate: true,
      liquidity: true,
      volume: true,
      spread: true,
      clarityScore: true,
    },
  },
} satisfies Prisma.OpportunityInclude;

export type OpportunityRow = Prisma.OpportunityGetPayload<{ include: typeof opportunityInclude }>;

/**
 * Filters that the database can express are pushed into the query; entry gap is applied in
 * memory because it is a signed value whose *magnitude* is what the user is filtering on.
 */
export async function listOpportunities(
  filters: OpportunityFilters = {},
): Promise<{ rows: OpportunityRow[]; totalBeforeFilters: number }> {
  const where: Prisma.OpportunityWhereInput = {};

  const marketWhere: Prisma.MarketWhereInput = {};
  if (filters.categories?.length) marketWhere.category = { in: filters.categories };
  if (filters.minScore != null) where.score = { gte: filters.minScore };
  if (filters.minConsensus != null) where.consensusScore = { gte: filters.minConsensus };
  if (filters.minAgreeingTraders != null) {
    where.qualifiedTraders = { gte: filters.minAgreeingTraders };
  }
  if (filters.minLiquidity != null) where.liquidity = { gte: filters.minLiquidity };
  if (filters.maxSpread != null) where.spread = { lte: filters.maxSpread };

  if (filters.resolvesWithinHours != null) {
    const cutoff = new Date(Date.now() + filters.resolvesWithinHours * 3_600_000);
    marketWhere.endDate = { lte: cutoff, gt: new Date() };
  }

  if (Object.keys(marketWhere).length > 0) where.market = marketWhere;

  const [rows, totalBeforeFilters] = await Promise.all([
    prisma.opportunity.findMany({
      where,
      include: opportunityInclude,
      orderBy: { score: "desc" },
      take: filters.limit ?? 100,
    }),
    prisma.opportunity.count(),
  ]);

  const maxGap = filters.maxEntryGapCents;
  const filtered =
    maxGap == null
      ? rows
      : rows.filter((row) => row.entryGap == null || Math.abs(row.entryGap) * 100 <= maxGap);

  return { rows: filtered, totalBeforeFilters };
}

/**
 * Categories that currently have scored opportunities, with counts.
 *
 * Drives the filter bar. Deliberately shows only categories with something in them, so the UI
 * never offers a filter that can only return an empty list.
 */
export async function listOpportunityCategories(): Promise<
  Array<{ category: Category; count: number }>
> {
  const rows = await prisma.opportunity.findMany({
    select: { market: { select: { category: true } } },
  });

  const counts = new Map<Category, number>();
  for (const row of rows) {
    const category = row.market.category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Filters seeded from saved settings, so the page opens in the user's configured state. */
export async function filtersFromSettings(): Promise<OpportunityFilters> {
  const settings = await getSettings();
  return {
    minConsensus: settings.minConsensusScore,
    minTraderScore: settings.minTraderScore,
    minLiquidity: settings.minLiquidity,
    maxSpread: settings.maxSpread,
    minAgreeingTraders: settings.minAgreeingTraders,
    // Stored as a price fraction (0.15 = 15c); the filter works in cents.
    maxEntryGapCents: settings.maxEntryGap * 100,
    excludeBots: settings.excludeBots,
  };
}

export async function getTopOpportunity(): Promise<OpportunityRow | null> {
  return prisma.opportunity.findFirst({ include: opportunityInclude, orderBy: { score: "desc" } });
}

export async function getOpportunityById(id: string): Promise<OpportunityRow | null> {
  return prisma.opportunity.findUnique({ where: { id }, include: opportunityInclude });
}

export interface DashboardStats {
  trackedTraders: number;
  activeTraders: number;
  listedOpportunities: number;
  strongConsensusMarkets: number;
  smartMoneyEvents24h: number;
  smartMoneyVolume24h: number | null;
  lastSyncAt: Date | null;
}

export async function getDashboardStats(strongConsensusThreshold = 60): Promise<DashboardStats> {
  const since = new Date(Date.now() - 24 * 3_600_000);

  const [
    trackedTraders,
    activeTraders,
    listedOpportunities,
    strongConsensusMarkets,
    recent,
    lastSync,
  ] = await Promise.all([
    prisma.trader.count(),
    prisma.trader.count({ where: { active: true } }),
    prisma.opportunity.count(),
    prisma.marketConsensus.count({ where: { score: { gte: strongConsensusThreshold } } }),
    prisma.tradeActivity.aggregate({
      where: { occurredAt: { gte: since }, type: "TRADE" },
      _count: true,
      _sum: { usdcSize: true },
    }),
    prisma.syncRun.findFirst({ where: { ok: true }, orderBy: { startedAt: "desc" } }),
  ]);

  return {
    trackedTraders,
    activeTraders,
    listedOpportunities,
    strongConsensusMarkets,
    smartMoneyEvents24h: recent._count,
    smartMoneyVolume24h: recent._sum.usdcSize ?? null,
    lastSyncAt: lastSync?.finishedAt ?? lastSync?.startedAt ?? null,
  };
}
