/**
 * Behaviour classification.
 *
 * This is a HEURISTIC, never a certainty, and the UI labels it "Behaviour classification" with the
 * reasoning shown alongside. The purpose is practical: a wallet that turns over 1,400 trades a week
 * with a four-minute median hold is not producing signals a human can manually replicate, so it
 * should be excludable from opportunity calculations (and it is, ON by default).
 *
 * Pure and synchronous. The clock is always passed in.
 */
import { intPlain, median, safeDivide, safeNumber } from "@/lib/num";
import type { ScoringConfig } from "./config";
import { DEFAULT_SCORING_CONFIG } from "./config";

export type BehaviorClassName =
  | "DISCRETIONARY"
  | "POSSIBLE_BOT"
  | "SCALPER"
  | "MARKET_MAKER"
  | "UNKNOWN";

export type Confidence = "low" | "moderate" | "high";

export interface BehaviorReason {
  label: string;
  detail: string;
}

export interface BehaviorResult {
  classification: BehaviorClassName;
  confidence: Confidence;
  /** 0-1, used for the trader-score penalty scaling. */
  confidenceScore: number;
  reasons: BehaviorReason[];
  /** Human sentence, e.g. "Possible scalper — high confidence". */
  summary: string;
  /** True when this wallet should be excluded while "Exclude likely bots/scalpers" is on. */
  excludable: boolean;
  metrics: BehaviorMetrics;
}

export interface BehaviorMetrics {
  tradeCount: number | null;
  tradesLast7d: number | null;
  tradesLast30d: number | null;
  medianHoldSeconds: number | null;
  heldToResolutionPct: number | null;
  bothSidesMarketCount: number | null;
  smallTradeShare: number | null;
  turnoverRatio: number | null;
  distinctMarkets: number | null;
}

export interface BehaviorTrade {
  conditionId: string;
  asset: string | null;
  outcomeIndex: number | null;
  side: "BUY" | "SELL" | null;
  /** Unix seconds. */
  timestamp: number;
  usdcSize: number | null;
}

export interface BehaviorInput {
  trades: BehaviorTrade[];
  /** Resolved positions, used for the held-to-resolution ratio. */
  closedPositionCount: number;
  /** Of those, how many were redeemed at settlement rather than sold out early. */
  heldToResolutionCount: number;
  portfolioValue: number | null;
  /** Evaluation clock, injected so the backtest can classify as-of a past date. */
  now: Date;
}

const DAY_SECONDS = 86_400;

/**
 * Median holding period, derived by FIFO-matching sells against buys per outcome token.
 * Returns null when there are no completed round trips.
 */
export function medianHoldingSeconds(trades: BehaviorTrade[]): number | null {
  const byAsset = new Map<string, BehaviorTrade[]>();
  for (const trade of trades) {
    const key = trade.asset ?? `${trade.conditionId}:${trade.outcomeIndex ?? 0}`;
    const list = byAsset.get(key);
    if (list) list.push(trade);
    else byAsset.set(key, [trade]);
  }

  const holdTimes: number[] = [];

  for (const assetTrades of byAsset.values()) {
    const ordered = [...assetTrades].sort((a, b) => a.timestamp - b.timestamp);
    // FIFO queue of open buy lots: [timestamp, remainingNotional]
    const lots: Array<{ timestamp: number; remaining: number }> = [];

    for (const trade of ordered) {
      const notional = Math.abs(safeNumber(trade.usdcSize) ?? 0);
      if (notional <= 0) continue;

      if (trade.side === "BUY") {
        lots.push({ timestamp: trade.timestamp, remaining: notional });
      } else if (trade.side === "SELL") {
        let toMatch = notional;
        while (toMatch > 0 && lots.length > 0) {
          const lot = lots[0];
          const matched = Math.min(lot.remaining, toMatch);
          holdTimes.push(trade.timestamp - lot.timestamp);
          lot.remaining -= matched;
          toMatch -= matched;
          if (lot.remaining <= 1e-9) lots.shift();
        }
      }
    }
  }

  return holdTimes.length > 0 ? median(holdTimes) : null;
}

/** Markets where the wallet bought BOTH outcomes — the classic market-making footprint. */
export function countBothSidesMarkets(trades: BehaviorTrade[]): number {
  const sidesByMarket = new Map<string, Set<number>>();
  for (const trade of trades) {
    if (trade.side !== "BUY" || trade.outcomeIndex === null) continue;
    const set = sidesByMarket.get(trade.conditionId) ?? new Set<number>();
    set.add(trade.outcomeIndex);
    sidesByMarket.set(trade.conditionId, set);
  }
  let count = 0;
  for (const sides of sidesByMarket.values()) {
    if (sides.size >= 2) count++;
  }
  return count;
}

export function computeBehaviorMetrics(
  input: BehaviorInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): BehaviorMetrics {
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const trades = input.trades;

  if (trades.length === 0) {
    return {
      tradeCount: 0,
      tradesLast7d: 0,
      tradesLast30d: 0,
      medianHoldSeconds: null,
      heldToResolutionPct: safeDivide(input.heldToResolutionCount, input.closedPositionCount),
      bothSidesMarketCount: 0,
      smallTradeShare: null,
      turnoverRatio: null,
      distinctMarkets: 0,
    };
  }

  const tradesLast7d = trades.filter((t) => nowSeconds - t.timestamp <= 7 * DAY_SECONDS).length;
  const tradesLast30d = trades.filter((t) => nowSeconds - t.timestamp <= 30 * DAY_SECONDS).length;

  const notionals = trades
    .map((t) => Math.abs(safeNumber(t.usdcSize) ?? 0))
    .filter((n) => n > 0);
  const smallTradeShare =
    notionals.length > 0
      ? notionals.filter((n) => n < config.behavior.smallTradeUsd).length / notionals.length
      : null;

  const notional30d = trades
    .filter((t) => nowSeconds - t.timestamp <= 30 * DAY_SECONDS)
    .reduce((acc, t) => acc + Math.abs(safeNumber(t.usdcSize) ?? 0), 0);

  return {
    tradeCount: trades.length,
    tradesLast7d,
    tradesLast30d,
    medianHoldSeconds: medianHoldingSeconds(trades),
    heldToResolutionPct: safeDivide(input.heldToResolutionCount, input.closedPositionCount),
    bothSidesMarketCount: countBothSidesMarkets(trades),
    smallTradeShare,
    turnoverRatio: safeDivide(notional30d, input.portfolioValue),
    distinctMarkets: new Set(trades.map((t) => t.conditionId)).size,
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)} seconds`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} minutes`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

/**
 * Scores each behaviour hypothesis independently, then takes the strongest.
 * Evidence is accumulated as points so the reasoning can be shown verbatim.
 */
export function classifyBehavior(
  input: BehaviorInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): BehaviorResult {
  const metrics = computeBehaviorMetrics(input, config);
  const cfg = config.behavior;

  if (!metrics.tradeCount || metrics.tradeCount < 5) {
    return {
      classification: "UNKNOWN",
      confidence: "low",
      confidenceScore: 0,
      reasons: [
        {
          label: "Not enough activity to classify",
          detail: `Only ${metrics.tradeCount ?? 0} trades have been ingested for this wallet.`,
        },
      ],
      summary: "Unknown — not enough activity to classify",
      excludable: false,
      metrics,
    };
  }

  const scores: Record<Exclude<BehaviorClassName, "UNKNOWN">, number> = {
    DISCRETIONARY: 1,
    POSSIBLE_BOT: 0,
    SCALPER: 0,
    MARKET_MAKER: 0,
  };
  const reasons: Record<Exclude<BehaviorClassName, "UNKNOWN">, BehaviorReason[]> = {
    DISCRETIONARY: [],
    POSSIBLE_BOT: [],
    SCALPER: [],
    MARKET_MAKER: [],
  };

  // --- Trade frequency ------------------------------------------------------
  if (metrics.tradesLast7d !== null && metrics.tradesLast7d >= cfg.veryHighFrequency7d) {
    scores.POSSIBLE_BOT += 3;
    scores.SCALPER += 2;
    reasons.POSSIBLE_BOT.push({
      label: "Very high trade frequency",
      detail: `${intPlain(metrics.tradesLast7d)} trades in the last 7 days.`,
    });
    reasons.SCALPER.push({
      label: "Very high trade frequency",
      detail: `${intPlain(metrics.tradesLast7d)} trades in the last 7 days.`,
    });
  } else if (metrics.tradesLast7d !== null && metrics.tradesLast7d >= cfg.highFrequency7d) {
    scores.POSSIBLE_BOT += 1.5;
    scores.SCALPER += 1.5;
    reasons.SCALPER.push({
      label: "High trade frequency",
      detail: `${intPlain(metrics.tradesLast7d)} trades in the last 7 days.`,
    });
    reasons.POSSIBLE_BOT.push({
      label: "High trade frequency",
      detail: `${intPlain(metrics.tradesLast7d)} trades in the last 7 days.`,
    });
  }

  // --- Holding period -------------------------------------------------------
  if (metrics.medianHoldSeconds !== null) {
    if (metrics.medianHoldSeconds <= cfg.scalperMedianHoldSeconds) {
      scores.SCALPER += 3;
      scores.POSSIBLE_BOT += 1;
      const detail = `Median holding period ${formatDuration(metrics.medianHoldSeconds)}.`;
      reasons.SCALPER.push({ label: "Very short holding periods", detail });
      reasons.POSSIBLE_BOT.push({ label: "Very short holding periods", detail });
    } else if (metrics.medianHoldSeconds >= 7 * DAY_SECONDS) {
      scores.DISCRETIONARY += 2;
      reasons.DISCRETIONARY.push({
        label: "Positions held for days or weeks",
        detail: `Median holding period ${formatDuration(metrics.medianHoldSeconds)}.`,
      });
    }
  }

  // --- Both sides of the same market ---------------------------------------
  if (
    metrics.bothSidesMarketCount !== null &&
    metrics.bothSidesMarketCount >= cfg.marketMakerBothSidesCount
  ) {
    scores.MARKET_MAKER += 3;
    reasons.MARKET_MAKER.push({
      label: "Trades both outcomes of the same market",
      detail: `Bought both sides in ${metrics.bothSidesMarketCount} markets, which is characteristic of quoting rather than taking a view.`,
    });
  }

  // --- Small repeated trades ------------------------------------------------
  if (
    metrics.smallTradeShare !== null &&
    metrics.smallTradeShare >= cfg.smallTradeShareThreshold &&
    metrics.tradeCount >= 100
  ) {
    scores.POSSIBLE_BOT += 2;
    scores.MARKET_MAKER += 1;
    reasons.POSSIBLE_BOT.push({
      label: "Many small repeated trades",
      detail: `${(metrics.smallTradeShare * 100).toFixed(0)}% of trades are under $${cfg.smallTradeUsd}.`,
    });
  }

  // --- Turnover -------------------------------------------------------------
  if (metrics.turnoverRatio !== null && metrics.turnoverRatio >= cfg.highTurnoverRatio) {
    scores.SCALPER += 1.5;
    scores.MARKET_MAKER += 1;
    reasons.SCALPER.push({
      label: "Extremely high turnover",
      detail: `30-day traded notional is ${metrics.turnoverRatio.toFixed(1)}× the current portfolio value.`,
    });
  }

  // --- Held to resolution ---------------------------------------------------
  if (metrics.heldToResolutionPct !== null && input.closedPositionCount >= 10) {
    if (metrics.heldToResolutionPct <= cfg.lowHeldToResolutionPct) {
      scores.SCALPER += 1.5;
      reasons.SCALPER.push({
        label: "Rarely holds to resolution",
        detail: `Only ${(metrics.heldToResolutionPct * 100).toFixed(0)}% of settled positions were held until the market resolved; the rest were traded out of early.`,
      });
    } else if (metrics.heldToResolutionPct >= 0.6) {
      scores.DISCRETIONARY += 2;
      reasons.DISCRETIONARY.push({
        label: "Usually holds to resolution",
        detail: `${(metrics.heldToResolutionPct * 100).toFixed(0)}% of settled positions were held until the market resolved, consistent with taking a view rather than trading noise.`,
      });
    }
  }

  // --- Repeated entry/exit in the same market -------------------------------
  if (metrics.distinctMarkets !== null && metrics.distinctMarkets > 0) {
    const tradesPerMarket = metrics.tradeCount / metrics.distinctMarkets;
    if (tradesPerMarket >= 20) {
      scores.SCALPER += 1.5;
      scores.MARKET_MAKER += 1;
      reasons.SCALPER.push({
        label: "Frequent entries and exits in the same market",
        detail: `Averages ${tradesPerMarket.toFixed(0)} trades per market across ${metrics.distinctMarkets} markets.`,
      });
    } else if (tradesPerMarket <= 4) {
      scores.DISCRETIONARY += 1;
    }
  }

  // --- Pick the winner ------------------------------------------------------
  const ranked = (Object.keys(scores) as Array<Exclude<BehaviorClassName, "UNKNOWN">>)
    .map((key) => ({ key, score: scores[key] }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const runnerUp = ranked[1];
  const margin = top.score - runnerUp.score;

  let confidence: Confidence = "low";
  let confidenceScore = 0.3;
  if (top.score >= 5 && margin >= 2) {
    confidence = "high";
    confidenceScore = 0.9;
  } else if (top.score >= 3 && margin >= 1) {
    confidence = "moderate";
    confidenceScore = 0.6;
  }

  const classification: BehaviorClassName = top.score <= 1 ? "DISCRETIONARY" : top.key;
  const chosenReasons = reasons[classification];

  const labels: Record<BehaviorClassName, string> = {
    DISCRETIONARY: "Discretionary trader",
    POSSIBLE_BOT: "Possible bot",
    SCALPER: "Possible scalper",
    MARKET_MAKER: "Possible market maker",
    UNKNOWN: "Unknown",
  };

  return {
    classification,
    confidence,
    confidenceScore,
    reasons:
      chosenReasons.length > 0
        ? chosenReasons
        : [
            {
              label: "No strong automation signals",
              detail:
                "Trade frequency, holding periods and position sizing are all within ranges typical of manual trading.",
            },
          ],
    summary: `${labels[classification]} — ${confidence} confidence`,
    // Only exclude when we actually believe it. A low-confidence guess should not silently
    // remove a wallet from the analysis.
    excludable:
      confidence !== "low" &&
      (classification === "POSSIBLE_BOT" ||
        classification === "SCALPER" ||
        classification === "MARKET_MAKER"),
    metrics,
  };
}
