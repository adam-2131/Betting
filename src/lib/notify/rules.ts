/**
 * WHAT IS WORTH INTERRUPTING SOMEONE FOR.
 *
 * The bar here is deliberately high, and it is the most important decision in the module.
 *
 * Every other check in this product exists to reject bad bets. An alert stream works in the
 * opposite direction: it surfaces things to act on, and a stream that fires often does not make
 * anyone bet better, it makes them bet more. It also stops being read, which is worse than not
 * having it — an unread alert is indistinguishable from no alert until the one that mattered goes
 * unread too.
 *
 * So the opportunity rule requires EVERY condition to hold at once rather than scoring them. On a
 * live board of 2,866 scored sides, 79 had any edge surviving the spread; adding the remaining
 * conditions is intended to leave a handful a week.
 *
 * One of those conditions deserves calling out. `minWinProbability` excludes longshots outright,
 * even though they carry the highest return-per-day figures on the board. Those numbers are real
 * arithmetic and terrible advice for anyone alerting on them: a 12% shot returns nothing eleven
 * times out of twelve, and a person who acts on pushed alerts is not running the hundreds of bets
 * that make the average show up.
 *
 * Pure and synchronous, so the bar can be tested without a database or a network.
 */
import { safeNumber } from "@/lib/num";

export type AlertKind =
  /** A position that passed every check, settling soon. */
  | "OPPORTUNITY"
  /** A qualifying game is about to start, so the chance to act is closing. */
  | "KICKOFF_SOON"
  /** A logged bet resolved. */
  | "BET_SETTLED"
  /** The closing-line record became conclusive, either way. */
  | "CLV_VERDICT"
  /** No successful sync recently, so every price on the board is stale. */
  | "SYNC_STALE";

export interface Alert {
  kind: AlertKind;
  /** Suppresses re-raising. Must be stable for "the same alert" and different otherwise. */
  dedupeKey: string;
  title: string;
  body: string;
  url?: string;
  priority: "low" | "normal" | "high";
}

export interface AlertThresholds {
  /** Only alert on positions whose capital returns within this many hours. */
  maxHoursToSettle: number;
  /** Minimum estimated chance of the position paying. Excludes longshots. */
  minWinProbability: number;
  /** Minimum edge in points remaining after the spread is paid. */
  minNetEdgePoints: number;
  minHorizonScore: number;
  minQualifiedTraders: number;
  minLiquidityUsd: number;
  /** Hours before kickoff at which a qualifying game becomes time-critical. */
  kickoffWarningHours: number;
  /** Hours without a successful sync before the data is called stale. */
  staleSyncHours: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  maxHoursToSettle: 48,
  // Below this the position loses most of the time, and an alert is the wrong way to learn that.
  minWinProbability: 0.4,
  minNetEdgePoints: 2,
  minHorizonScore: 60,
  minQualifiedTraders: 2,
  minLiquidityUsd: 5_000,
  kickoffWarningHours: 3,
  staleSyncHours: 3,
};

export interface AlertCandidate {
  opportunityId: string;
  question: string;
  outcomeLabel: string;
  /** Plain-language instruction, from `bet-instruction.ts`. */
  action: string;
  horizonScore: number | null;
  netEdgePoints: number | null;
  winProbability: number | null;
  effectivePrice: number | null;
  liquidity: number | null;
  qualifiedTraders: number;
  settlesAt: Date | null;
  gameStartTime: Date | null;
}

/** Day stamp, so a position that still qualifies tomorrow can alert again but not twice today. */
function dayStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function hoursUntil(target: Date | null, now: Date): number | null {
  if (!target) return null;
  return (target.getTime() - now.getTime()) / 3_600_000;
}

/** True only when every condition holds. Deliberately not a score. */
export function qualifies(
  candidate: AlertCandidate,
  now: Date,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): boolean {
  const hours = hoursUntil(candidate.settlesAt, now);
  if (hours === null || hours <= 0 || hours > thresholds.maxHoursToSettle) return false;

  const edge = safeNumber(candidate.netEdgePoints);
  if (edge === null || edge < thresholds.minNetEdgePoints) return false;

  const win = safeNumber(candidate.winProbability);
  if (win === null || win < thresholds.minWinProbability) return false;

  const score = safeNumber(candidate.horizonScore);
  if (score === null || score < thresholds.minHorizonScore) return false;

  if (candidate.qualifiedTraders < thresholds.minQualifiedTraders) return false;

  const liquidity = safeNumber(candidate.liquidity);
  if (liquidity === null || liquidity < thresholds.minLiquidityUsd) return false;

  const price = safeNumber(candidate.effectivePrice);
  if (price === null || price <= 0 || price >= 1) return false;

  return true;
}

export function opportunityAlerts(
  candidates: AlertCandidate[],
  now: Date,
  baseUrl: string,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): Alert[] {
  const alerts: Alert[] = [];

  for (const candidate of candidates) {
    if (!qualifies(candidate, now, thresholds)) continue;

    const win = candidate.winProbability ?? 0;
    const price = candidate.effectivePrice ?? 0;
    const profit = price > 0 ? (1 - price) / price : 0;
    const hours = hoursUntil(candidate.settlesAt, now) ?? 0;
    const kickoff = hoursUntil(candidate.gameStartTime, now);

    const imminent = kickoff !== null && kickoff <= thresholds.kickoffWarningHours && kickoff > 0;

    alerts.push({
      kind: imminent ? "KICKOFF_SOON" : "OPPORTUNITY",
      // Day-stamped: the same position qualifying again next week is news, twice today is not.
      dedupeKey: `${imminent ? "kickoff" : "opp"}:${candidate.opportunityId}:${dayStamp(now)}`,
      title: imminent
        ? `Starts in ${Math.max(1, Math.round(kickoff))}h — ${candidate.outcomeLabel}`
        : `${candidate.outcomeLabel} — ${Math.round(win * 100)}% chance`,
      body: [
        candidate.action,
        "",
        candidate.question,
        `Pay ${(price * 100).toFixed(1)}c. $1 returns $${(1 + profit).toFixed(2)} if it wins, $0 if not.`,
        `Estimated ${Math.round(win * 100)}% chance, so it loses ${Math.round((1 - win) * 100)}% of the time.`,
        `Settles in about ${Math.max(1, Math.round(hours))}h. ${candidate.qualifiedTraders} tracked traders on this side.`,
        "",
        "Check it against the live market before betting — the price above came from the last sync.",
      ].join("\n"),
      url: `${baseUrl}/opportunities/${candidate.opportunityId}`,
      priority: imminent ? "high" : "normal",
    });
  }

  return alerts;
}

export interface SettledBet {
  betId: string;
  outcomeLabel: string;
  question: string;
  won: boolean;
  pnl: number | null;
  stake: number;
}

export function settlementAlerts(bets: SettledBet[], baseUrl: string): Alert[] {
  return bets.map((bet) => ({
    kind: "BET_SETTLED" as const,
    // No day stamp: a bet settles exactly once.
    dedupeKey: `settled:${bet.betId}`,
    title: bet.won
      ? `Won ${formatMoney(bet.pnl ?? 0)} — ${bet.outcomeLabel}`
      : `Lost ${formatMoney(bet.stake)} — ${bet.outcomeLabel}`,
    body: [
      bet.question,
      "",
      bet.won
        ? `Your ${formatMoney(bet.stake)} returned ${formatMoney(bet.stake + (bet.pnl ?? 0))}.`
        : `Your ${formatMoney(bet.stake)} is gone.`,
    ].join("\n"),
    url: `${baseUrl}/bets`,
    priority: "low" as const,
  }));
}

export interface ClvState {
  verdict: string;
  count: number;
  meanPoints: number | null;
}

/**
 * Alerts only when the record becomes CONCLUSIVE, in either direction.
 *
 * The negative case is the one worth pushing. A run of losses is obvious; systematically paying
 * above the closing price is not, and it is the finding that should stop someone.
 */
export function clvAlert(state: ClvState, baseUrl: string): Alert | null {
  if (state.verdict !== "BEATING_THE_CLOSE" && state.verdict !== "PAYING_UP") return null;

  const positive = state.verdict === "BEATING_THE_CLOSE";
  const mean = state.meanPoints ?? 0;

  return {
    kind: "CLV_VERDICT",
    // Keyed on the verdict, so it fires once per change of state rather than every pass.
    dedupeKey: `clv:${state.verdict}`,
    title: positive
      ? "Your prices are beating the closing line"
      : "You are consistently paying above the closing line",
    body: positive
      ? `Across ${state.count} measured bets you are buying ${mean.toFixed(2)} points below where the market finishes. That is evidence the selection is finding real prices. It is not profit — costs still have to be cleared — but it is the necessary half.`
      : `Across ${state.count} measured bets you are buying ${Math.abs(mean).toFixed(2)} points above where the market finishes. No hit rate corrects that. This is the point to stop and change something.`,
    url: `${baseUrl}/bets`,
    priority: positive ? "normal" : "high",
  };
}

/**
 * Silent staleness is the failure that matters most: the board keeps rendering confident prices
 * that stopped being true hours ago, and nothing about the page looks wrong.
 */
export function staleSyncAlert(
  lastSuccessfulSync: Date | null,
  now: Date,
  baseUrl: string,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): Alert | null {
  if (!lastSuccessfulSync) return null;
  const hours = (now.getTime() - lastSuccessfulSync.getTime()) / 3_600_000;
  if (hours < thresholds.staleSyncHours) return null;

  return {
    kind: "SYNC_STALE",
    // Hour-stamped so a persistent outage nags once an hour rather than once per pass.
    dedupeKey: `stale:${now.toISOString().slice(0, 13)}`,
    title: `Data is ${Math.round(hours)}h old`,
    body: `No sync has completed successfully in ${Math.round(hours)} hours, so every price on the board is stale. Prices move most on markets about to settle, which is exactly what the board shows. Do not bet from it until this clears.`,
    url: `${baseUrl}/settings`,
    priority: "high",
  };
}

function formatMoney(value: number): string {
  return `$${Math.abs(value).toFixed(2)}`;
}
