/**
 * Recording a bet.
 *
 * Deliberately free of Next-specific imports so it can be exercised outside a request. The server
 * action in `app/bets/actions.ts` is a thin wrapper that adds cache revalidation; everything that
 * decides what gets written lives here.
 *
 * The price is read LIVE rather than copied off the card. The card's figure came from the last
 * bulk sync, and on an imminent market that has been observed three cents adrift — larger than
 * most edges on the board. CLV is the difference between two prices, so an error in the entry is
 * an error in the measurement, and the measurement is the entire point of the log.
 */
import { prisma } from "@/lib/db";
import { fetchBook } from "@/lib/polymarket/clob";
import { normalizeAsks, simulateFill } from "@/lib/analysis/book-fill";

export type RecordBetResult =
  | { ok: true; message: string; entryPrice: number; betId: string }
  | { ok: false; message: string };

/** Default stake. Matches the unit every card illustrates. */
export const DEFAULT_STAKE = 1;

export async function recordBet(
  opportunityId: string,
  stake = DEFAULT_STAKE,
): Promise<RecordBetResult> {
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      outcomeIndex: true,
      effectivePrice: true,
      currentPrice: true,
      horizonScore: true,
      modelEstimateMid: true,
      netEdgePoints: true,
      qualifiedTraders: true,
      market: {
        select: {
          id: true,
          question: true,
          outcomes: true,
          clobTokenIds: true,
          endDate: true,
          gameStartTime: true,
        },
      },
    },
  });

  if (!opportunity) return { ok: false, message: "That opportunity no longer exists." };

  const outcomeLabel =
    opportunity.market.outcomes[opportunity.outcomeIndex] ?? `Outcome ${opportunity.outcomeIndex}`;

  let entryPrice = opportunity.effectivePrice ?? opportunity.currentPrice;
  let live = false;

  const token = opportunity.market.clobTokenIds[opportunity.outcomeIndex];
  if (token) {
    try {
      const book = await fetchBook(token);
      const fill = simulateFill(normalizeAsks(book?.asks ?? []), stake);
      if (fill.averagePrice !== null) {
        entryPrice = fill.averagePrice;
        live = true;
      }
    } catch {
      // Keep the stored price; `clvSource` below records that it was a snapshot.
    }
  }

  if (entryPrice === null || entryPrice <= 0 || entryPrice >= 1) {
    return { ok: false, message: "There is no usable price for this side right now." };
  }

  /**
   * When this market's price stops absorbing information.
   *
   * Kickoff for a game, NOT the estimated settlement. The closing line is the price immediately
   * before the event starts; once it is underway the price reacts to a partly-known result and is
   * no longer a forecast worth comparing against.
   */
  const closesAt = opportunity.market.gameStartTime ?? opportunity.market.endDate;

  const bet = await prisma.betLog.create({
    data: {
      marketId: opportunity.market.id,
      outcomeIndex: opportunity.outcomeIndex,
      outcomeLabel,
      question: opportunity.market.question,
      entryPrice,
      stake,
      horizonScore: opportunity.horizonScore,
      modelMid: opportunity.modelEstimateMid,
      netEdgePoints: opportunity.netEdgePoints,
      qualifiedTraders: opportunity.qualifiedTraders,
      closesAt,
      clvSource: live ? null : "ENTRY_FROM_SNAPSHOT",
    },
  });

  return {
    ok: true,
    betId: bet.id,
    entryPrice,
    message: live
      ? `Logged at ${(entryPrice * 100).toFixed(1)}¢, read live from the book.`
      : `Logged at ${(entryPrice * 100).toFixed(1)}¢ from the board snapshot — the live book could not be read, so this price may be stale.`,
  };
}
