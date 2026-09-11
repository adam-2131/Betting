/**
 * SHORT-HORIZON SCORE — 0 to 100.
 *
 * Answers the question the main Opportunity Score deliberately ignores: if I put a dollar in
 * today, how much does it earn PER DAY it stays locked up, and how much of that survives contact
 * with the order book?
 *
 * The two rankings disagree constantly, which is the point. A 12% edge that settles in eight
 * months earns about 0.05% a day. A 4% edge that settles on Sunday earns 4%. The opportunity score
 * ranks the first one higher and is right to, because it is measuring a different thing — it even
 * applies `shortTimeRemainingPenalty` to markets resolving within twelve hours, penalising exactly
 * the property this ranking is hunting for.
 *
 * THREE CORRECTIONS THIS MAKES THAT THE OPPORTUNITY SCORE DOES NOT.
 *
 * 1. YOU BUY AT THE ASK, NOT THE MID. `computeModelEstimate` compares the model against the mid
 *    price, which is the fair value nobody can actually transact at. Over an eight-month hold that
 *    distinction is rounding; over three days it is frequently the entire trade. A 2¢ spread on a
 *    50¢ contract is 4% of capital, and a 4% edge held for three days is 1.3% a day. Cross the
 *    spread and there is nothing left.
 *
 * 2. EDGE IS NETTED AGAINST EXECUTION BEFORE RANKING, not scored as a separate component that a
 *    strong consensus can outvote. `edgeRetention` reports what fraction of the theoretical edge
 *    is still there after crossing the spread, and a trade whose edge does not survive that is
 *    penalised hard rather than merely marked down.
 *
 * 3. THE DOWNSIDE IS TESTED. The model already publishes an uncertainty band that widens when few
 *    traders back a signal. This scores the LOW end of that band as well as the middle, so a
 *    position only rates highly if it is still positive when the model is wrong by the full width
 *    of its own admitted error.
 *
 * WHAT THIS IS NOT. It is not a prediction, and a high score is not a claim that money will be
 * made. Every number downstream of `modelEstimate` inherits that estimate's caveat: it is a
 * bounded nudge away from the market price in the direction smart money is leaning, not a measured
 * probability. Ranking by return per day makes the comparison between two trades fair; it does not
 * make either of them good.
 *
 * Pure and synchronous.
 */
import { safeNumber, scaleToScore, usdPlain } from "@/lib/num";
import type { ScoringConfig } from "./config";
import { DEFAULT_SCORING_CONFIG } from "./config";
import { AMBIGUOUS_CLARITY_THRESHOLD } from "./clarity";
import { applyPenalties, combineComponents, type ScorePenalty, type ScoreResult } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How confident we are about WHEN this settles, which is separate from what it settles to. */
export type SettlementTiming =
  /** A scheduled event start plus a known typical duration. The best case. */
  | "SCHEDULED"
  /** A stated end date, which is when the market closes rather than when it necessarily settles. */
  | "STATED"
  /** No date at all — return per day cannot be computed. */
  | "UNKNOWN";

export interface HorizonInput {
  /** Mid / last price, 0..1. The fair value, which is not what you transact at. */
  currentPrice: number | null;
  bestAsk: number | null;
  spread: number | null;
  liquidity: number | null;
  /** Central model probability, from `computeModelEstimate`. */
  modelMid: number | null;
  /** Pessimistic end of the model's own uncertainty band. */
  modelLow: number | null;
  /** When the market is scheduled to close. */
  endDate: Date | null;
  /**
   * Better settlement estimate when one exists — for sports this is kickoff plus the game's
   * typical length, because `endDate` on a game market is kickoff and understates the hold.
   */
  settlesAt: Date | null;
  settlementTiming: SettlementTiming;
  /** 0-100 resolution-clarity heuristic. */
  clarityScore: number | null;
  /** Underlying smart-money consensus score, 0-100. */
  consensusScore: number | null;
  qualifiedTraders: number;
  now: Date;
}

export interface HorizonResult extends ScoreResult {
  /** Real hours until settlement. Not floored — this is what gets displayed. */
  hoursToSettlement: number | null;
  /** Denominator actually used for the per-day figures, floored at `minCapitalDays`. */
  capitalDays: number | null;
  /** True when `capitalDays` was raised off the real horizon by the floor. */
  capitalDaysFloored: boolean;
  /** The price you would actually pay, including the spread and a slippage allowance. */
  effectivePrice: number | null;
  /** Model mid minus the mid price, in probability points. The theoretical edge. */
  grossEdgePoints: number | null;
  /** Model mid minus the effective price, in probability points. The edge you can actually get. */
  netEdgePoints: number | null;
  /** Fraction of the theoretical edge surviving execution, 0..1. Null when there was no edge. */
  edgeRetention: number | null;
  /** Expected return per dollar staked, at the central model estimate. */
  expectedReturnOnCapital: number | null;
  /** Expected return per dollar staked, at the pessimistic end of the model band. */
  downsideReturnOnCapital: number | null;
  /** Return on capital divided by days locked up. The headline number. */
  returnPerDay: number | null;
  /** Profit per dollar if the position simply wins. Not probability-weighted. */
  upsideIfRight: number | null;
  /**
   * The model's own estimated chance of being paid — which is just `modelMid`, named for what it
   * means here.
   *
   * Reported separately from the return figures because they are different facts and the return
   * figures alone are misleading without it. Expected return per day is an average over outcomes;
   * this is how often the average is actually collected. A position can have an excellent expected
   * return and still lose the entire stake most of the time, and on a board answering "what should
   * I bet" that has to be said rather than left to be inferred from the price.
   */
  estimatedWinProbability: number | null;
  /** Plain-language summary of the trade-off, always populated. */
  verdict: string;
}

/**
 * The bid and ask for ONE OUTCOME of a binary market.
 *
 * VERIFIED TRAP: Gamma reports a single `bestBid`/`bestAsk` pair per market, and they belong to
 * outcome index 0 only. On the Bills/Texans moneyline — outcomes ["Bills","Texans"] priced
 * ["0.525","0.475"] — Gamma returned bestBid 0.52 and bestAsk 0.53, whose midpoint is exactly
 * 0.525, the price of outcome 0. Reading that ask as the cost of the Texans side would have the
 * ranking buying the wrong team at the wrong price.
 *
 * The other side follows from the CTF identity rather than from another request: complementary
 * shares always sum to $1, so selling one outcome at its bid is buying the other at 1 − bid.
 *
 *   ask(1) = 1 − bid(0)      bid(1) = 1 − ask(0)
 *
 * The spread is preserved, which is the arithmetic check that this is right:
 * (1 − bid0) − (1 − ask0) = ask0 − bid0.
 */
export function quotesForOutcome(
  outcomeIndex: number,
  bestBid: number | null,
  bestAsk: number | null,
): { bid: number | null; ask: number | null } {
  const bid = safeNumber(bestBid);
  const ask = safeNumber(bestAsk);

  if (outcomeIndex === 0) return { bid, ask };

  // Anything beyond a two-outcome market cannot be complemented from one quote pair. Negative-risk
  // events have many legs, and guessing there would be worse than reporting nothing.
  if (outcomeIndex !== 1) return { bid: null, ask: null };

  return {
    bid: ask === null ? null : 1 - ask,
    ask: bid === null ? null : 1 - bid,
  };
}

/**
 * The price a buyer actually transacts at.
 *
 * Prefers the real quoted ask. Falls back to reconstructing it from the mid and half the spread,
 * which is what the ask would be on a symmetric book. Adds a slippage allowance on top, because
 * the quoted best ask is for an unknown and often tiny size — the Bills/Texans 2H moneyline quoted
 * a 96¢ spread against $2.36 of depth, and a "best ask" from a book like that is not a price
 * anyone fills at.
 */
export function effectiveEntryPrice(
  currentPrice: number | null,
  bestAsk: number | null,
  spread: number | null,
  slippageAllowance: number,
): number | null {
  const mid = safeNumber(currentPrice);
  const ask = safeNumber(bestAsk);
  const spreadValue = safeNumber(spread);

  let base: number | null = null;
  if (ask !== null && ask > 0 && ask < 1) {
    base = ask;
  } else if (mid !== null && spreadValue !== null) {
    base = mid + spreadValue / 2;
  } else {
    base = mid;
  }

  if (base === null || base <= 0) return null;

  const withSlippage = base * (1 + slippageAllowance);
  // A price at or above $1 has no upside left and is not a tradeable entry.
  if (withSlippage >= 1) return null;
  return withSlippage;
}

/** Hours until capital comes back, preferring a scheduled settlement over a stated close. */
function hoursToSettlement(input: HorizonInput): number | null {
  const target = input.settlesAt ?? input.endDate;
  if (!target) return null;
  const hours = (target.getTime() - input.now.getTime()) / HOUR_MS;
  // A date already in the past tells us nothing useful about the remaining hold.
  return hours > 0 ? hours : null;
}

/** Logarithmic: the step from $500 to $5k matters far more than $50k to $100k. */
function liquidityScore(liquidity: number | null, range: [number, number]): number | null {
  const value = safeNumber(liquidity);
  if (value === null) return null;
  if (value <= 0) return 0;
  const [min, max] = range;
  return scaleToScore(
    Math.log10(Math.max(value, 1)),
    Math.log10(Math.max(min, 1)),
    Math.log10(Math.max(max, 10)),
  );
}

export function computeHorizonScore(
  input: HorizonInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): HorizonResult {
  const cfg = config.shortHorizon;

  const mid = safeNumber(input.currentPrice);
  const modelMid = safeNumber(input.modelMid);
  const modelLow = safeNumber(input.modelLow);

  const effectivePrice = effectiveEntryPrice(mid, input.bestAsk, input.spread, cfg.slippageAllowance);

  const realHours = hoursToSettlement(input);
  const realDays = realHours === null ? null : realHours / 24;
  const capitalDays = realDays === null ? null : Math.max(realDays, cfg.minCapitalDays);
  const capitalDaysFloored = realDays !== null && realDays < cfg.minCapitalDays;

  // --- Edge, gross and net ---------------------------------------------------
  const grossEdge = modelMid !== null && mid !== null ? modelMid - mid : null;
  const netEdge = modelMid !== null && effectivePrice !== null ? modelMid - effectivePrice : null;

  // Only meaningful when there was a theoretical edge to erode in the first place.
  const edgeRetention =
    grossEdge !== null && netEdge !== null && grossEdge > 0
      ? Math.max(0, Math.min(1, netEdge / grossEdge))
      : null;

  const expectedReturnOnCapital =
    netEdge !== null && effectivePrice !== null && effectivePrice > 0
      ? netEdge / effectivePrice
      : null;

  const downsideReturnOnCapital =
    modelLow !== null && effectivePrice !== null && effectivePrice > 0
      ? (modelLow - effectivePrice) / effectivePrice
      : null;

  const upsideIfRight =
    effectivePrice !== null && effectivePrice > 0 ? (1 - effectivePrice) / effectivePrice : null;

  const returnPerDay =
    expectedReturnOnCapital !== null && capitalDays !== null && capitalDays > 0
      ? expectedReturnOnCapital / capitalDays
      : null;

  const downsideReturnPerDay =
    downsideReturnOnCapital !== null && capitalDays !== null && capitalDays > 0
      ? downsideReturnOnCapital / capitalDays
      : null;

  // --- Components ------------------------------------------------------------
  const capitalEfficiency = scaleToScore(
    returnPerDay,
    cfg.returnPerDayRange[0],
    cfg.returnPerDayRange[1],
  );

  // Scored on the same scale as the central estimate, so "still positive when stress-tested"
  // reads directly as a score above zero rather than needing its own calibration.
  const downsideTested = scaleToScore(
    downsideReturnPerDay,
    cfg.returnPerDayRange[0],
    cfg.returnPerDayRange[1],
  );

  const signalConfidence = safeNumber(input.consensusScore);

  // Half how much edge survives the spread, half how much depth stands behind the quote. A tight
  // spread on an empty book is not executable, and neither is a deep book quoted 20¢ wide.
  const executability = (() => {
    const depth = liquidityScore(input.liquidity, cfg.liquidityRange);
    const retention = edgeRetention === null ? null : edgeRetention * 100;
    if (depth === null && retention === null) return null;
    if (depth === null) return retention;
    if (retention === null) return depth;
    return retention * 0.5 + depth * 0.5;
  })();

  const settlementCertainty = (() => {
    // Knowing WHEN it settles and knowing WHAT settles it are different risks; both belong here
    // because either one being unclear means the horizon this whole score divides by is unreliable.
    const timingScore =
      input.settlementTiming === "SCHEDULED" ? 100 : input.settlementTiming === "STATED" ? 65 : 0;
    const clarity = safeNumber(input.clarityScore);
    if (clarity === null) return timingScore;
    return timingScore * 0.5 + clarity * 0.5;
  })();

  const { baseScore, components } = combineComponents([
    {
      key: "capitalEfficiency",
      label: "Return per day of capital",
      value: capitalEfficiency,
      weight: cfg.weights.capitalEfficiency,
      detail:
        returnPerDay !== null
          ? `${(returnPerDay * 100).toFixed(2)}% per day over ${formatDays(capitalDays)}`
          : "No resolution date, so return per day cannot be computed",
    },
    {
      key: "downsideTested",
      label: "Edge at the low end of the model band",
      value: downsideTested,
      weight: cfg.weights.downsideTested,
      detail:
        downsideReturnPerDay !== null
          ? `${(downsideReturnPerDay * 100).toFixed(2)}% per day if the model is wrong by the full width of its uncertainty`
          : "No model band available",
    },
    {
      key: "signalConfidence",
      label: "Smart money consensus",
      value: signalConfidence,
      weight: cfg.weights.signalConfidence,
      detail: `${input.qualifiedTraders} qualified trader${input.qualifiedTraders === 1 ? "" : "s"} on this side`,
    },
    {
      key: "executability",
      label: "Executability",
      value: executability,
      weight: cfg.weights.executability,
      detail:
        edgeRetention !== null
          ? `${Math.round(edgeRetention * 100)}% of the theoretical edge survives crossing the spread`
          : input.liquidity !== null
            ? `${usdPlain(input.liquidity)} of depth behind the quote`
            : "No spread or liquidity reported",
    },
    {
      key: "settlementCertainty",
      label: "Settlement certainty",
      value: settlementCertainty,
      weight: cfg.weights.settlementCertainty,
      detail: settlementTimingDetail(input.settlementTiming),
    },
  ]);

  // --- Penalties -------------------------------------------------------------
  const penalties: ScorePenalty[] = [];

  if (realDays === null) {
    penalties.push({
      key: "unknown-horizon",
      label: "No resolution date",
      points: -cfg.unknownHorizonPenalty,
      detail:
        "Without a resolution date there is no way to know how long capital stays tied up, which is the entire basis of this ranking.",
    });
  }

  if (netEdge !== null && netEdge <= 0) {
    penalties.push({
      key: "negative-net-edge",
      label: "Edge does not survive the spread",
      points: -cfg.negativeNetEdgePenalty,
      detail:
        grossEdge !== null && grossEdge > 0
          ? `The model sees ${(grossEdge * 100).toFixed(1)} points of edge against the mid price, but buying at ${formatCentsPlain(effectivePrice)} consumes all of it. You would be paying more than the estimate is worth.`
          : `The model does not see this side as underpriced at ${formatCentsPlain(effectivePrice)}.`,
    });
  }

  if (effectivePrice !== null && effectivePrice < cfg.longshotPrice) {
    penalties.push({
      key: "longshot",
      label: "Longshot pricing",
      points: -cfg.longshotPenalty,
      detail: `At ${formatCentsPlain(effectivePrice)} the return figures are dominated by a payout that rarely arrives. Most positions at this price lose the entire stake.`,
    });
  }

  const liquidity = safeNumber(input.liquidity);
  if (liquidity !== null && liquidity < cfg.thinBookUsd) {
    penalties.push({
      key: "thin-book",
      label: "Book too thin to fill",
      points: -cfg.thinBookPenalty,
      detail: `${usdPlain(liquidity)} of depth means the quoted price is unlikely to be the price you get, so the computed return is optimistic.`,
    });
  }

  if (input.qualifiedTraders < cfg.minQualifiedTraders) {
    penalties.push({
      key: "insufficient-sample",
      label: "Thin smart-money backing",
      points: -cfg.insufficientSamplePenalty,
      detail: `Only ${input.qualifiedTraders} qualified trader${input.qualifiedTraders === 1 ? " holds" : "s hold"} this side, so the model estimate driving these returns rests on very little.`,
    });
  }

  if (input.clarityScore !== null && input.clarityScore < AMBIGUOUS_CLARITY_THRESHOLD) {
    penalties.push({
      key: "ambiguous",
      label: "Ambiguous resolution criteria",
      points: -config.opportunity.ambiguousResolutionPenalty,
      detail:
        "Subjective resolution criteria can delay settlement well past the stated date, which stretches the hold this ranking is built on.",
    });
  }

  const result = applyPenalties(baseScore, penalties, components);

  return {
    ...result,
    hoursToSettlement: realHours,
    capitalDays,
    capitalDaysFloored,
    effectivePrice,
    grossEdgePoints: grossEdge === null ? null : grossEdge * 100,
    netEdgePoints: netEdge === null ? null : netEdge * 100,
    edgeRetention,
    expectedReturnOnCapital,
    downsideReturnOnCapital,
    returnPerDay,
    upsideIfRight,
    estimatedWinProbability: modelMid,
    verdict: buildVerdict({
      returnPerDay,
      downsideReturnOnCapital,
      netEdge,
      edgeRetention,
      realHours,
      capitalDaysFloored,
      effectivePrice,
      estimatedWinProbability: modelMid,
    }),
  };
}

function settlementTimingDetail(timing: SettlementTiming): string {
  switch (timing) {
    case "SCHEDULED":
      return "Settles on a scheduled event, so the hold length is known rather than estimated";
    case "STATED":
      return "Has a stated close date, though settlement can lag it";
    case "UNKNOWN":
      return "No resolution date published";
  }
}

function formatDays(days: number | null): string {
  if (days === null) return "an unknown period";
  if (days < 1.05) return "about a day";
  if (days < 2) return `${days.toFixed(1)} days`;
  return `${Math.round(days)} days`;
}

/** Cents without the `Unavailable` fallback, for use inside sentences that already guard nulls. */
function formatCentsPlain(price: number | null): string {
  if (price === null) return "an unavailable price";
  return `${(price * 100).toFixed(1)}¢`;
}

/**
 * One sentence naming the actual trade-off. Always returns something: a trade with no edge is a
 * finding worth stating plainly, not an empty panel.
 */
function buildVerdict(input: {
  returnPerDay: number | null;
  downsideReturnOnCapital: number | null;
  netEdge: number | null;
  edgeRetention: number | null;
  realHours: number | null;
  capitalDaysFloored: boolean;
  effectivePrice: number | null;
  estimatedWinProbability: number | null;
}): string {
  const { returnPerDay, downsideReturnOnCapital, netEdge, edgeRetention, realHours } = input;

  if (realHours === null) {
    return "No resolution date is published, so there is no way to say how quickly this would pay out.";
  }

  if (netEdge !== null && netEdge <= 0) {
    if (edgeRetention !== null && edgeRetention <= 0) {
      return `The spread is wider than the entire estimated edge. Buying at ${formatCentsPlain(input.effectivePrice)} hands the whole advantage to whoever is on the other side.`;
    }
    return `At ${formatCentsPlain(input.effectivePrice)} the model does not see enough underpricing here to be worth the capital.`;
  }

  if (returnPerDay === null) {
    return "There is an edge here, but not enough information to express it as a return per day.";
  }

  const window = describeWindow(realHours);
  const perDay = `${(returnPerDay * 100).toFixed(2)}% per day`;

  const floored = input.capitalDaysFloored
    ? " Per-day figures are computed over a full day even though it settles sooner, since capital cannot realistically be redeployed faster than that."
    : "";

  // Expected return is an average over outcomes; this is how often the average is collected. A
  // position can earn 44% a day in expectation and still lose everything three times in four, and
  // the per-day figure on its own reads as though it will not.
  const win = input.estimatedWinProbability;
  const lossWarning =
    win !== null && win < 0.5
      ? ` On the model's own estimate this still loses the entire stake about ${Math.round((1 - win) * 100)}% of the time — the return is an average over many such bets, not what to expect from this one.`
      : "";

  if (downsideReturnOnCapital !== null && downsideReturnOnCapital > 0) {
    return `Settles ${window} and earns about ${perDay} on the capital it ties up, still positive at the pessimistic end of the model's own range.${lossWarning}${floored}`;
  }

  return `Settles ${window} and earns about ${perDay} at the central estimate, but turns negative at the low end of the model's range — the edge depends on the estimate being close to right.${lossWarning}${floored}`;
}

function describeWindow(hours: number): string {
  if (hours < 24) return `in about ${Math.max(1, Math.round(hours))} hours`;
  const days = hours / 24;
  if (days < 2) return "in about a day";
  if (days < 14) return `in about ${Math.round(days)} days`;
  if (days < 60) return `in about ${Math.round(days / 7)} weeks`;
  return `in about ${Math.round(days / 30)} months`;
}
