/**
 * Read-side queries for the Traders screens.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

const traderListInclude = {
  performance: true,
  _count: { select: { positions: { where: { isOpen: true } } } },
} satisfies Prisma.TraderInclude;

export type TraderListRow = Prisma.TraderGetPayload<{ include: typeof traderListInclude }>;

export async function listTraders(options: { includeInactive?: boolean } = {}): Promise<TraderListRow[]> {
  return prisma.trader.findMany({
    where: options.includeInactive ? {} : { active: true },
    include: traderListInclude,
    orderBy: [{ performance: { smartScore: { sort: "desc", nulls: "last" } } }, { displayName: "asc" }],
  });
}

const traderDetailInclude = {
  performance: true,
  categoryPerformance: { orderBy: { closedCount: "desc" } },
  positions: {
    where: { isOpen: true, size: { gt: 0 } },
    orderBy: { currentValue: "desc" },
    include: {
      market: {
        select: {
          id: true,
          question: true,
          slug: true,
          eventSlug: true,
          category: true,
          outcomes: true,
          endDate: true,
          liquidity: true,
        },
      },
    },
  },
} satisfies Prisma.TraderInclude;

export type TraderDetail = Prisma.TraderGetPayload<{ include: typeof traderDetailInclude }>;

export async function getTrader(id: string): Promise<TraderDetail | null> {
  return prisma.trader.findUnique({ where: { id }, include: traderDetailInclude });
}

export async function getTraderByWallet(wallet: string): Promise<TraderDetail | null> {
  return prisma.trader.findUnique({
    where: { wallet: wallet.toLowerCase() },
    include: traderDetailInclude,
  });
}

export interface ClosedPositionRow {
  id: string;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  outcome: string | null;
  category: string;
  avgPrice: number | null;
  costBasisUsd: number | null;
  realizedPnl: number | null;
  won: boolean | null;
  resolvedAt: Date | null;
}

export async function getClosedPositions(traderId: string, take = 100): Promise<ClosedPositionRow[]> {
  return prisma.closedPosition.findMany({
    where: { traderId },
    orderBy: [{ resolvedAt: { sort: "desc", nulls: "last" } }],
    take,
    select: {
      id: true,
      title: true,
      slug: true,
      eventSlug: true,
      outcome: true,
      category: true,
      avgPrice: true,
      costBasisUsd: true,
      realizedPnl: true,
      won: true,
      resolvedAt: true,
    },
  });
}

/**
 * Cumulative realized PnL over time, built from settled positions in resolution order.
 *
 * Only positions with a known resolution date are included — a point on a time series needs a
 * time, and inventing one would distort the shape of the curve.
 */
export async function getRealizedPnlCurve(
  traderId: string,
): Promise<{ date: string; cumulative: number; pnl: number }[]> {
  const rows = await prisma.closedPosition.findMany({
    where: { traderId, resolvedAt: { not: null }, realizedPnl: { not: null } },
    orderBy: { resolvedAt: "asc" },
    select: { resolvedAt: true, realizedPnl: true },
  });

  let cumulative = 0;
  const byDay = new Map<string, { cumulative: number; pnl: number }>();
  for (const row of rows) {
    if (!row.resolvedAt || row.realizedPnl === null) continue;
    cumulative += row.realizedPnl;
    const day = row.resolvedAt.toISOString().slice(0, 10);
    const prior = byDay.get(day);
    byDay.set(day, { cumulative, pnl: (prior?.pnl ?? 0) + row.realizedPnl });
  }

  return [...byDay.entries()].map(([date, v]) => ({ date, ...v }));
}

/** Realized PnL grouped by calendar month. */
export async function getMonthlyPnl(traderId: string): Promise<{ month: string; pnl: number }[]> {
  const rows = await prisma.closedPosition.findMany({
    where: { traderId, resolvedAt: { not: null }, realizedPnl: { not: null } },
    orderBy: { resolvedAt: "asc" },
    select: { resolvedAt: true, realizedPnl: true },
  });

  const byMonth = new Map<string, number>();
  for (const row of rows) {
    if (!row.resolvedAt || row.realizedPnl === null) continue;
    const month = row.resolvedAt.toISOString().slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + row.realizedPnl);
  }

  return [...byMonth.entries()].map(([month, pnl]) => ({ month, pnl }));
}
