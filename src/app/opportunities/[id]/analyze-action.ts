"use server";

/**
 * Runs the deep dive for one opportunity, on demand.
 *
 * A server action rather than part of the page load because it is several live API calls against
 * one market — cheap once, ruinous if it ran for every row on every render. Nothing is written to
 * the database: this is a point-in-time reading whose whole value is that it was taken just now,
 * and a stored copy would immediately become the same stale snapshot it exists to correct.
 */
import { prisma } from "@/lib/db";
import { runDeepDive, type DeepDive } from "@/lib/analysis/deep-dive";

export type AnalyzeResult =
  | { ok: true; dive: DeepDive; outcomeLabel: string }
  | { ok: false; message: string };

export async function analyzeOpportunity(opportunityId: string): Promise<AnalyzeResult> {
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      outcomeIndex: true,
      effectivePrice: true,
      currentPrice: true,
      modelEstimateMid: true,
      netEdgePoints: true,
      market: {
        select: {
          conditionId: true,
          clobTokenIds: true,
          outcomes: true,
          eventId: true,
        },
      },
    },
  });

  if (!opportunity) return { ok: false, message: "That opportunity no longer exists." };

  // Every open market in the same event, for the overround check. Restricted to the event so a
  // missing eventId yields an empty set rather than a nonsensical comparison across markets.
  const eventMarkets = opportunity.market.eventId
    ? await prisma.market.findMany({
        where: { eventId: opportunity.market.eventId, closed: false },
        select: {
          id: true,
          question: true,
          outcomes: true,
          prices: true,
          bestAsk: true,
          spread: true,
          sportsMarketType: true,
          negRisk: true,
        },
      })
    : [];

  const outcomeLabel =
    opportunity.market.outcomes[opportunity.outcomeIndex] ?? `Outcome ${opportunity.outcomeIndex}`;

  try {
    const dive = await runDeepDive({
      outcomeIndex: opportunity.outcomeIndex,
      outcomeLabel,
      clobTokenIds: opportunity.market.clobTokenIds,
      conditionId: opportunity.market.conditionId,
      // Fall back to the mid when no effective price was stored, so the drift check still runs.
      boardEffectivePrice: opportunity.effectivePrice ?? opportunity.currentPrice,
      modelMid: opportunity.modelEstimateMid,
      boardNetEdgePoints: opportunity.netEdgePoints,
      eventMarkets,
      now: new Date(),
    });

    return { ok: true, dive, outcomeLabel };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The analysis could not be completed.",
    };
  }
}
