/**
 * SPORTS ANGLE.
 *
 * Sports markets are not just another category, and treating them as one loses three things that
 * only exist here.
 *
 * WHEN A POSITION WAS OPENED CARRIES INFORMATION. In a politics market, a position taken in March
 * and the same position taken in September are the same opinion at different times. In a sports
 * market they are not. Lineups, injuries, weather and rest all land in the final day, the closing
 * line is the most accurate price the market ever shows, and money that arrives late arrives after
 * the information that decides the game. A wager placed a week out was placed without most of it.
 * `lateMoneyShare` measures how much of the tracked money on a side arrived inside that window.
 *
 * THE LINE MOVING AGAINST YOUR ENTRY IS TWO DIFFERENT FACTS AT ONCE. The existing entry-gap
 * analysis reads "they bought at 45¢, it is 52¢ now" purely as a worse entry, and it is right that
 * it is one. But it is also evidence the read was correct: the market came to them. Those pull in
 * opposite directions and collapsing them into one penalty throws away the confirming half. Worse,
 * the same 7¢ gap means something completely different depending on whether those traders are
 * still adding or quietly getting out — and consensus already tracks that. Crossing the two gives
 * a verdict that neither yields alone:
 *
 *                     line moved TOWARD them     line moved AGAINST them
 *   still adding      STEAM                      DOUBLING DOWN
 *   not adding        CONFIRMED                  CAPITULATING
 *
 * THE GAME CAN ALREADY BE UNDERWAY. Polymarket keeps a game market trading after kickoff, so a
 * screen that only knows about `endDate` will happily rank a position in a match that is currently
 * being played, against people watching it. This app has no live score feed, so that is a
 * categorically different bet from the one the score describes, and it is flagged rather than
 * ranked.
 *
 * Everything here is derived from data already stored. Nothing calls out to a sports data provider
 * and nothing pretends to know anything about the teams.
 *
 * Pure and synchronous.
 */
import { safeNumber } from "@/lib/num";
import {
  classifySportsMarket,
  estimatedSettlementAt,
  gameDurationHours,
  isTradeableSportsMarket,
  type SportsMarketKind,
  type TradeabilityResult,
} from "@/lib/polymarket/sports";
import type { ScoringConfig } from "./config";
import { DEFAULT_SCORING_CONFIG } from "./config";

const HOUR_MS = 3_600_000;

/** Where a game sits relative to now. Drives both ranking and the in-play warning. */
export type GamePhase =
  /** Days out. The line is still soft and most information has not landed. */
  | "EARLY"
  /** Inside a day or so. Information is landing and the line is sharpening. */
  | "APPROACHING"
  /** Hours away. This is the sharpest the market gets. */
  | "IMMINENT"
  /** Kickoff has passed and the game is presumed underway. */
  | "IN_PLAY"
  /** Past the estimated end of the game, awaiting settlement. */
  | "ENDED"
  /** Not a game market — a season future, or no kickoff time published. */
  | "NOT_A_GAME";

/** What the price move since the tracked traders entered says, read together with their flow. */
export type LineVerdict =
  /** Market moved their way and they are still buying. The strongest read available. */
  | "STEAM"
  /** Market moved their way; they are holding. Thesis confirmed, but you pay up for it. */
  | "CONFIRMED"
  /** Market moved against them and they are adding. Conviction, and a better entry than they got. */
  | "DOUBLING_DOWN"
  /** Market moved against them and they are reducing. Treated as a warning. */
  | "CAPITULATING"
  /** No material move either way. */
  | "FLAT"
  /** Not enough information to say. */
  | "UNKNOWN";

export interface SportsEntry {
  /** USD bought. */
  usd: number | null;
  /** When the buy happened. */
  at: Date | null;
}

export interface SportsAngleInput {
  gameStartTime: Date | null;
  league: string | null;
  sportsMarketType: string | null;
  liquidity: number | null;
  spread: number | null;
  /** Today's price for the side being evaluated. */
  currentPrice: number | null;
  /** Exposure-weighted price the tracked traders got in at. */
  weightedEntryPrice: number | null;
  /** Tracked traders currently adding to this side. */
  increasingCount: number;
  /** Tracked traders currently reducing. */
  decreasingCount: number;
  /** Individual tracked buys on this side, used for the late-money split. */
  entries: SportsEntry[];
  now: Date;
}

export interface SportsAngle {
  /** True only for game-level markets. Season futures are excluded from every sports screen. */
  isGame: boolean;
  phase: GamePhase;
  hoursToKickoff: number | null;
  /** Kickoff plus the league's typical game length. Null when there is no kickoff time. */
  settlesAt: Date | null;
  kind: SportsMarketKind;
  tradeable: TradeabilityResult;
  /** Tracked USD that arrived inside the late-money window. */
  lateMoneyUsd: number;
  /** Tracked USD that arrived before it. */
  earlyMoneyUsd: number;
  /** Late as a share of all dated tracked money on this side, 0..1. */
  lateMoneyShare: number | null;
  /** Price move since the tracked traders entered, in probability points. Signed. */
  lineMovePoints: number | null;
  lineVerdict: LineVerdict;
  /** One plain-language sentence per finding. */
  notes: string[];
  /** Things that should stop you, not merely inform you. */
  warnings: string[];
}

/**
 * Everything sports-specific about one side of one market.
 *
 * Returns a fully-populated result even for non-sports or non-game markets, with `isGame: false`,
 * so callers can branch on one field instead of null-checking a whole object.
 */
export function analyzeSportsAngle(
  input: SportsAngleInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): SportsAngle {
  const cfg = config.sports;
  const kind = classifySportsMarket(input.sportsMarketType);
  const tradeable = isTradeableSportsMarket({
    liquidity: input.liquidity,
    spread: input.spread,
  });

  const kickoff = input.gameStartTime;
  const isGame = kickoff !== null;
  const settlesAt = estimatedSettlementAt(kickoff, input.league);
  const hoursToKickoff =
    kickoff === null ? null : (kickoff.getTime() - input.now.getTime()) / HOUR_MS;

  const phase = resolvePhase(hoursToKickoff, input.league, cfg);

  const { lateMoneyUsd, earlyMoneyUsd, lateMoneyShare } = splitLateMoney(
    input.entries,
    kickoff,
    cfg.lateMoneyWindowHours,
  );

  const { lineMovePoints, lineVerdict } = readLine(input, cfg.flatLineThresholdPoints);

  const notes: string[] = [];
  const warnings: string[] = [];

  if (!isGame) {
    notes.push(
      "This is a season-long market rather than a single game, so there is no kickoff to time and capital stays committed until the competition finishes.",
    );
  }

  if (!tradeable.tradeable && tradeable.reason) {
    warnings.push(
      `${tradeable.reason}. Polymarket auto-generates hundreds of these per game and most are never quoted.`,
    );
  }

  if (phase === "IN_PLAY") {
    warnings.push(
      "Kickoff has passed, so this game is presumed to be underway. Prices now move on events happening live, which this dashboard cannot see — the smart-money positions below were taken before the game started.",
    );
  }

  if (phase === "ENDED") {
    warnings.push(
      "The game is past its estimated finish and the market has not settled yet. The outcome is likely already decided, so any remaining price is about settlement timing rather than the result.",
    );
  }

  if (phase === "IMMINENT") {
    notes.push(
      `Kickoff is in about ${formatHours(hoursToKickoff)}. This is the sharpest a sports market gets: lineups and late news are already priced in.`,
    );
  }

  if (phase === "EARLY") {
    notes.push(
      "The game is still days away, so lineups, injuries and weather have not landed yet and the line will move a great deal before it settles.",
    );
  }

  // Guarded on TOTAL dated money, not on late money. A share of zero is the case the second
  // branch exists to describe, and gating on `lateMoneyUsd > 0` would silence it there.
  if (lateMoneyShare !== null && lateMoneyUsd + earlyMoneyUsd > 0) {
    if (lateMoneyShare >= 0.6) {
      notes.push(
        `${Math.round(lateMoneyShare * 100)}% of the tracked money here arrived within ${cfg.lateMoneyWindowHours} hours of kickoff, which is when the information that decides a game becomes public.`,
      );
    } else if (lateMoneyShare <= 0.15) {
      notes.push(
        `Nearly all of this position was built more than ${cfg.lateMoneyWindowHours} hours before kickoff, so it was taken without the late news the closing line reflects.`,
      );
    }
  }

  const verdictNote = describeLineVerdict(lineVerdict, lineMovePoints);
  if (verdictNote) {
    if (lineVerdict === "CAPITULATING") warnings.push(verdictNote);
    else notes.push(verdictNote);
  }

  if (kind.tier === "EXOTIC" && tradeable.tradeable) {
    notes.push(
      `This is a ${kind.label.toLowerCase()} market rather than a main line. It is quoted, but these books are thinner and move less predictably than the moneyline.`,
    );
  }

  return {
    isGame,
    phase,
    hoursToKickoff,
    settlesAt,
    kind,
    tradeable,
    lateMoneyUsd,
    earlyMoneyUsd,
    lateMoneyShare,
    lineMovePoints,
    lineVerdict,
    notes,
    warnings,
  };
}

function resolvePhase(
  hoursToKickoff: number | null,
  league: string | null,
  cfg: ScoringConfig["sports"],
): GamePhase {
  if (hoursToKickoff === null) return "NOT_A_GAME";
  if (hoursToKickoff > cfg.earlyHours) return "EARLY";
  if (hoursToKickoff > cfg.imminentHours) return "APPROACHING";
  if (hoursToKickoff > 0) return "IMMINENT";
  // Kickoff has passed. Still "in play" until the game has had time to finish.
  return -hoursToKickoff < gameDurationHours(league) ? "IN_PLAY" : "ENDED";
}

/**
 * Splits tracked buys into money that arrived inside the late window and money that did not.
 *
 * Entries with no timestamp are excluded from BOTH sides rather than defaulted into one. Position
 * open times come from the activity log, which is fetched incrementally, so a missing timestamp
 * means "not ingested yet" and not "arrived early". Defaulting those into the early bucket would
 * make every newly-tracked wallet look like slow money.
 */
function splitLateMoney(
  entries: SportsEntry[],
  kickoff: Date | null,
  windowHours: number,
): { lateMoneyUsd: number; earlyMoneyUsd: number; lateMoneyShare: number | null } {
  if (kickoff === null) return { lateMoneyUsd: 0, earlyMoneyUsd: 0, lateMoneyShare: null };

  const cutoff = kickoff.getTime() - windowHours * HOUR_MS;
  let late = 0;
  let early = 0;

  for (const entry of entries) {
    const usd = safeNumber(entry.usd);
    if (usd === null || usd <= 0 || entry.at === null) continue;
    // A buy after kickoff is in-play money, which is late by any definition.
    if (entry.at.getTime() >= cutoff) late += usd;
    else early += usd;
  }

  const total = late + early;
  return {
    lateMoneyUsd: late,
    earlyMoneyUsd: early,
    lateMoneyShare: total > 0 ? late / total : null,
  };
}

/**
 * Reads the price move since entry TOGETHER with current flow.
 *
 * The move alone is ambiguous — it says the market disagrees with their entry price but not
 * whether they still believe it. Flow alone is ambiguous too. Crossed, they resolve each other.
 */
function readLine(
  input: SportsAngleInput,
  flatThresholdPoints: number,
): { lineMovePoints: number | null; lineVerdict: LineVerdict } {
  const current = safeNumber(input.currentPrice);
  const entry = safeNumber(input.weightedEntryPrice);

  if (current === null || entry === null) {
    return { lineMovePoints: null, lineVerdict: "UNKNOWN" };
  }

  const movePoints = (current - entry) * 100;

  if (Math.abs(movePoints) < flatThresholdPoints) {
    return { lineMovePoints: movePoints, lineVerdict: "FLAT" };
  }

  const adding = input.increasingCount > input.decreasingCount;
  const reducing = input.decreasingCount > input.increasingCount;

  // A rise favours holders of this side, because they own it below the current price.
  const movedTowardThem = movePoints > 0;

  if (movedTowardThem) {
    return { lineMovePoints: movePoints, lineVerdict: adding ? "STEAM" : "CONFIRMED" };
  }
  if (reducing) return { lineMovePoints: movePoints, lineVerdict: "CAPITULATING" };
  if (adding) return { lineMovePoints: movePoints, lineVerdict: "DOUBLING_DOWN" };

  // Moved against them, and no net flow either way.
  return { lineMovePoints: movePoints, lineVerdict: "UNKNOWN" };
}

export function describeLineVerdict(
  verdict: LineVerdict,
  movePoints: number | null,
): string | null {
  const move = movePoints === null ? null : Math.abs(movePoints).toFixed(1);

  switch (verdict) {
    case "STEAM":
      return `The line has moved ${move} points toward this side since the tracked traders bought, and they are still adding. The market has come round to their read and they have not taken the profit.`;
    case "CONFIRMED":
      return `The line has moved ${move} points toward this side since they bought, so the market now agrees with them — but that also means you are paying a worse price than they did for the same bet.`;
    case "DOUBLING_DOWN":
      return `The line has moved ${move} points against this side and the tracked traders are buying more, not less. You would be entering at a better price than they did.`;
    case "CAPITULATING":
      return `The line has moved ${move} points against this side and the tracked traders are reducing. The cheaper price is cheaper because the people whose record justifies this listing are getting out.`;
    case "FLAT":
      return "The price has barely moved since the tracked traders entered, so today's trade is close to the one they made.";
    case "UNKNOWN":
      return null;
  }
}

function formatHours(hours: number | null): string {
  if (hours === null) return "an unknown time";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 24) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}
