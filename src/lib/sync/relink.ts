/**
 * Local repair pass. Makes no network calls.
 *
 * Rows arrive before the markets they reference. A trade is stored as soon as `/activity` returns
 * it, but the corresponding market row may not exist yet — and for a long time it could not exist,
 * because `/markets?condition_ids=X` silently returns nothing for closed markets unless
 * `closed=true` is passed (see ARCHITECTURE.md §1.5). Those rows kept `marketId: null`, and since
 * activity is fetched incrementally they would never be revisited.
 *
 * Anything joined by market — the track record's per-market view, and the backtest's entire
 * universe — is invisible while that link is missing. This pass reconnects by `conditionId`, which
 * is the stable key both sides already store, so it is idempotent and safe to run every sync.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface RelinkStats {
  activityLinked: number;
  closedPositionsLinked: number;
  /** Markets given a real settlement time observed from closed positions. */
  resolvedAtRecovered: number;
  /** Markets whose resolution time could not be observed, so it was set to unavailable. */
  resolvedAtCleared: number;
  stillUnknownConditionIds: number;
}

const CHUNK = 500;

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** conditionId -> Market.id, for the condition ids passed in. */
async function marketIdsFor(conditionIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const batch of chunk([...new Set(conditionIds)])) {
    const rows = await prisma.market.findMany({
      where: { conditionId: { in: batch } },
      select: { id: true, conditionId: true },
    });
    for (const row of rows) map.set(row.conditionId, row.id);
  }
  return map;
}

export async function relinkOrphans(): Promise<RelinkStats> {
  const stats: RelinkStats = {
    activityLinked: 0,
    closedPositionsLinked: 0,
    resolvedAtRecovered: 0,
    resolvedAtCleared: 0,
    stillUnknownConditionIds: 0,
  };

  // Position.marketId is required by the schema, so open positions cannot be orphaned.
  const [orphanActivity, orphanClosed] = await Promise.all([
    prisma.tradeActivity.findMany({
      where: { marketId: null },
      select: { id: true, conditionId: true },
    }),
    prisma.closedPosition.findMany({
      where: { marketId: null },
      select: { id: true, conditionId: true },
    }),
  ]);

  const allConditionIds = [
    ...orphanActivity.map((r) => r.conditionId),
    ...orphanClosed.map((r) => r.conditionId),
  ].filter(Boolean);

  const marketIds = await marketIdsFor(allConditionIds);
  stats.stillUnknownConditionIds = new Set(
    allConditionIds.filter((id) => !marketIds.has(id)),
  ).size;

  // Group by target market so each update touches many rows at once, rather than one per row.
  const groupByMarket = (rows: Array<{ id: string; conditionId: string }>) => {
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const marketId = marketIds.get(row.conditionId);
      if (!marketId) continue;
      const list = grouped.get(marketId) ?? [];
      list.push(row.id);
      grouped.set(marketId, list);
    }
    return grouped;
  };

  for (const [marketId, ids] of groupByMarket(orphanActivity)) {
    for (const batch of chunk(ids)) {
      const { count } = await prisma.tradeActivity.updateMany({
        where: { id: { in: batch } },
        data: { marketId },
      });
      stats.activityLinked += count;
    }
  }

  for (const [marketId, ids] of groupByMarket(orphanClosed)) {
    for (const batch of chunk(ids)) {
      const { count } = await prisma.closedPosition.updateMany({
        where: { id: { in: batch } },
        data: { marketId },
      });
      stats.closedPositionsLinked += count;
    }
  }

  // --- Repairing resolvedAt ------------------------------------------------
  //
  // `Market.resolvedAt` is derived from Gamma's `endDate`, which is the *scheduled* close, not the
  // settlement moment. Markets frequently resolve early ("will X happen by December" settling in
  // October), leaving a resolved market with an end date that has not arrived.
  //
  // This used to be handled by clamping such rows to `NOW()`. That was wrong, and quietly so. It
  // invents a resolution time equal to whenever a sync happened to run, which then:
  //   * stacks thousands of unrelated markets onto a single instant — an audit found 5,026 rows
  //     sharing one day, against ~1,500 on the busiest genuine day;
  //   * hands the backtest a signal time of `stamped - horizon`, which can fall *after* the market
  //     really settled, so the outcome is already known at the moment we pretend to predict it.
  //
  // The brief's rule applies exactly here: if a value cannot reliably be obtained, it must be
  // unavailable rather than fabricated. So we recover a real timestamp where one is observable and
  // null the rest.
  //
  // `ClosedPosition.resolvedAt` comes from the trader API's per-position settlement timestamp — a
  // real observation, not a schedule.
  //
  // Two choices in the estimator below, both about erring in the safe direction:
  //
  //   `won IS NOT NULL` keeps only positions that settled cleanly at 1 or 0. A position sold
  //   before resolution carries the sale time, which is *earlier* than settlement and would drag
  //   the estimate off.
  //
  //   MIN rather than median, because every settled position is timestamped at or after the
  //   actual resolution (redemptions trail it, sometimes by weeks — measured p90 was +81h). The
  //   earliest is therefore the closest to the true instant, and any residual error puts our
  //   resolvedAt slightly *late*. That matters: the backtest derives its signal time as
  //   `resolvedAt − horizon`, so an estimate that is too late pushes the signal moment toward the
  //   outcome being known. MIN keeps that margin as small as the data allows.
  const recovered = await prisma.$executeRaw(Prisma.sql`
    UPDATE "Market" m
    SET "resolvedAt" = sub.settled_at
    FROM (
      SELECT "marketId", MIN("resolvedAt") AS settled_at
      FROM "ClosedPosition"
      WHERE "resolvedAt" IS NOT NULL AND "marketId" IS NOT NULL AND "won" IS NOT NULL
      GROUP BY "marketId"
    ) sub
    WHERE m.id = sub."marketId"
      AND m."resolved" = true
      AND sub.settled_at <= NOW()
      -- Only rows whose current stamp is untrustworthy: still in the future, or clamped to a
      -- sync time while the scheduled close had not yet passed.
      AND (m."resolvedAt" IS NULL OR m."resolvedAt" > NOW() OR m."endDate" > NOW())
  `);
  stats.resolvedAtRecovered = recovered;

  // Whatever is left has no observable settlement time. Null beats a fabricated one: the backtest
  // filters on `resolvedAt`, so these drop out of the sample instead of poisoning it.
  //
  // The NOT EXISTS is load-bearing. Without it this clears the rows the statement above just
  // repaired — a recovered market still has a future `endDate` (that is why it was suspect in the
  // first place), so it matches this predicate too. The first run of this pair recovered 2,213
  // markets and then nulled all 2,655, quietly undoing its own work.
  const nulled = await prisma.$executeRaw(Prisma.sql`
    UPDATE "Market" m SET "resolvedAt" = NULL
    WHERE m."resolved" = true
      AND m."resolvedAt" IS NOT NULL
      AND (m."resolvedAt" > NOW() OR m."endDate" > NOW())
      AND NOT EXISTS (
        SELECT 1 FROM "ClosedPosition" cp
        WHERE cp."marketId" = m.id
          AND cp."resolvedAt" IS NOT NULL
          AND cp."won" IS NOT NULL
          AND cp."resolvedAt" <= NOW()
      )
  `);
  stats.resolvedAtCleared = nulled;

  return stats;
}
