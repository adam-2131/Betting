/**
 * Raises alerts and delivers them.
 *
 * Records first, sends second, and always in that order. A notification row written before any
 * network call means a failed delivery is a missing push rather than lost information, and the
 * in-app history stays complete whether or not a channel is configured at all.
 *
 * Runs last in the sync so it sees the results of every other stage in the same pass — an
 * opportunity scored moments ago, a bet settled moments ago.
 */
import { prisma } from "@/lib/db";
import { deliver } from "@/lib/notify/channel";
import {
  clvAlert,
  opportunityAlerts,
  settlementAlerts,
  staleSyncAlert,
  type Alert,
  type AlertCandidate,
} from "@/lib/notify/rules";
import { describeBet } from "@/lib/bet-instruction";
import { summarizeClv } from "@/lib/clv";

export interface NotifyStats {
  raised: number;
  /** Already raised earlier, so not raised again. */
  deduped: number;
  sent: number;
  failed: number;
  /** True when no delivery channel is configured; alerts are recorded but not pushed. */
  channelConfigured: boolean;
}

/** Bets settled within this window are still worth telling someone about. */
const SETTLEMENT_LOOKBACK_MS = 24 * 3_600_000;

export async function syncNotifications(): Promise<NotifyStats> {
  const now = new Date();
  const webhook = process.env.ALERT_WEBHOOK_URL;
  const baseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

  const stats: NotifyStats = {
    raised: 0,
    deduped: 0,
    sent: 0,
    failed: 0,
    channelConfigured: Boolean(webhook && webhook.trim()),
  };

  const alerts: Alert[] = [...(await opportunityCandidates(now, baseUrl))];

  // --- Bets that settled since the last pass ---------------------------------
  const settled = await prisma.betLog.findMany({
    where: { resolved: true, placedAt: { gte: new Date(now.getTime() - 30 * 24 * 3_600_000) } },
    select: { id: true, outcomeLabel: true, question: true, won: true, pnl: true, stake: true },
    orderBy: { placedAt: "desc" },
    take: 50,
  });
  alerts.push(
    ...settlementAlerts(
      settled
        .filter((b) => b.won !== null)
        .map((b) => ({
          betId: b.id,
          outcomeLabel: b.outcomeLabel,
          question: b.question,
          won: b.won === true,
          pnl: b.pnl,
          stake: b.stake,
        })),
      baseUrl,
    ),
  );

  // --- Has the closing-line record become conclusive? ------------------------
  const measured = await prisma.betLog.findMany({
    where: { clvPoints: { not: null } },
    select: { entryPrice: true, closingPrice: true },
  });
  const clv = summarizeClv(
    measured.map((b) => ({ entryPrice: b.entryPrice, closingPrice: b.closingPrice ?? 0 })),
  );
  const clvVerdict = clvAlert(
    { verdict: clv.verdict, count: clv.count, meanPoints: clv.meanPoints },
    baseUrl,
  );
  if (clvVerdict) alerts.push(clvVerdict);

  // --- Is the board showing stale prices? ------------------------------------
  //
  // Deliberately looks at the last successful MARKETS sync rather than any sync: the trader and
  // score stages can succeed while market prices go unrefreshed, which is precisely the state
  // that makes the board wrong while looking healthy.
  const lastMarkets = await prisma.syncRun.findFirst({
    where: { stage: "markets", ok: true },
    orderBy: { startedAt: "desc" },
    select: { finishedAt: true, startedAt: true },
  });
  const stale = staleSyncAlert(lastMarkets?.finishedAt ?? lastMarkets?.startedAt ?? null, now, baseUrl);
  if (stale) alerts.push(stale);

  // --- Record, then deliver ---------------------------------------------------
  for (const alert of alerts) {
    const existing = await prisma.notification.findUnique({
      where: { dedupeKey: alert.dedupeKey },
      select: { id: true },
    });
    if (existing) {
      stats.deduped++;
      continue;
    }

    const row = await prisma.notification.create({
      data: {
        kind: alert.kind,
        dedupeKey: alert.dedupeKey,
        title: alert.title,
        body: alert.body,
        url: alert.url,
        priority: alert.priority,
      },
    });
    stats.raised++;

    if (!stats.channelConfigured) continue;

    const result = await deliver(
      { title: alert.title, body: alert.body, url: alert.url, priority: alert.priority },
      webhook,
    );

    if (result.ok) {
      await prisma.notification.update({ where: { id: row.id }, data: { sentAt: new Date() } });
      stats.sent++;
    } else {
      await prisma.notification.update({
        where: { id: row.id },
        data: { sendError: result.error?.slice(0, 500) ?? "Delivery failed" },
      });
      stats.failed++;
    }
  }

  return stats;
}

/** Loads scored rows and turns them into alert candidates with a plain-language instruction. */
async function opportunityCandidates(now: Date, baseUrl: string): Promise<Alert[]> {
  const rows = await prisma.opportunity.findMany({
    where: { settlesAt: { gt: now }, netEdgePoints: { gt: 0 } },
    orderBy: { horizonScore: "desc" },
    take: 100,
    select: {
      id: true,
      outcomeIndex: true,
      horizonScore: true,
      netEdgePoints: true,
      modelEstimateMid: true,
      effectivePrice: true,
      liquidity: true,
      qualifiedTraders: true,
      settlesAt: true,
      market: {
        select: {
          question: true,
          outcomes: true,
          sportsMarketType: true,
          gameStartTime: true,
        },
      },
    },
  });

  const candidates: AlertCandidate[] = rows.map((row) => {
    const outcomeLabel = row.market.outcomes[row.outcomeIndex] ?? `Outcome ${row.outcomeIndex}`;
    const instruction = describeBet({
      question: row.market.question,
      outcomeLabel,
      outcomes: row.market.outcomes,
      outcomeIndex: row.outcomeIndex,
      sportsMarketType: row.market.sportsMarketType,
    });

    return {
      opportunityId: row.id,
      question: row.market.question,
      outcomeLabel,
      action: instruction.action,
      horizonScore: row.horizonScore,
      netEdgePoints: row.netEdgePoints,
      winProbability: row.modelEstimateMid,
      effectivePrice: row.effectivePrice,
      liquidity: row.liquidity,
      qualifiedTraders: row.qualifiedTraders,
      settlesAt: row.settlesAt,
      gameStartTime: row.market.gameStartTime,
    };
  });

  return opportunityAlerts(candidates, now, baseUrl);
}
