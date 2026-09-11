"use server";

/**
 * Server actions for the bet log.
 *
 * Thin on purpose: everything that decides what gets written lives in `lib/bets/record.ts`, which
 * has no Next imports and can therefore be exercised outside a request. These wrappers exist only
 * to add cache revalidation.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { DEFAULT_STAKE, recordBet, type RecordBetResult } from "@/lib/bets/record";

export type LogBetResult = RecordBetResult;

export async function logBet(
  opportunityId: string,
  stake = DEFAULT_STAKE,
): Promise<LogBetResult> {
  const result = await recordBet(opportunityId, stake);
  if (result.ok) {
    revalidatePath("/bets");
    revalidatePath("/cash-soon");
  }
  return result;
}

export async function deleteBet(betId: string): Promise<void> {
  await prisma.betLog.delete({ where: { id: betId } });
  revalidatePath("/bets");
}
