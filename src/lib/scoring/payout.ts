/**
 * Payout mathematics.
 *
 * A Polymarket outcome share costs `price` dollars (0..1) and pays exactly $1 if that outcome
 * wins, or $0 if it does not.
 *
 *   shares       = stake / price
 *   grossPayout  = shares × $1
 *   profit       = grossPayout − stake
 *   lossIfWrong  = stake            (the entire stake, always)
 *
 * Every function here is pure and total: no input produces NaN or Infinity. A price of 0 has no
 * meaningful share count, so the result is null and the UI renders "Unavailable".
 *
 * A larger payout is a direct consequence of a lower price, which means the market thinks the
 * outcome is less likely. Payout size is never treated as a quality signal anywhere in this app.
 */
import { safeNumber } from "@/lib/num";

export interface PayoutResult {
  stake: number;
  price: number;
  /** Shares bought. Null when the price is 0 or otherwise unusable. */
  shares: number | null;
  /** MAXIMUM payout if the outcome wins. */
  grossPayout: number | null;
  /** Profit if the outcome wins (gross payout minus stake). */
  profit: number | null;
  /** Loss if the outcome loses — always the full stake. */
  lossIfWrong: number;
  /** Profit / stake. Null when the stake is 0. */
  returnPct: number | null;
  /**
   * Probability at which this bet breaks even, which for a $1-payout share is simply the price.
   * Below this the position has negative expected value.
   */
  breakEvenProbability: number | null;
  /** True when inputs were outside the usable range and the result is not meaningful. */
  invalid: boolean;
  invalidReason: string | null;
}

/** Prices must be a real probability. 0 and 1 are rejected: neither is a tradeable entry. */
export function isTradeablePrice(price: unknown): price is number {
  const p = safeNumber(price);
  return p !== null && p > 0 && p < 1;
}

export function calculatePayout(stakeInput: unknown, priceInput: unknown): PayoutResult {
  const stake = safeNumber(stakeInput);
  const price = safeNumber(priceInput);

  const base = {
    stake: stake ?? 0,
    price: price ?? 0,
    shares: null,
    grossPayout: null,
    profit: null,
    lossIfWrong: 0,
    returnPct: null,
    breakEvenProbability: null,
  };

  if (price === null) {
    return { ...base, invalid: true, invalidReason: "Market price unavailable" };
  }
  if (price <= 0) {
    // A zero price implies infinite shares. Refuse rather than emit Infinity.
    return { ...base, invalid: true, invalidReason: "Price must be above 0¢" };
  }
  if (price >= 1) {
    return { ...base, invalid: true, invalidReason: "Price must be below $1.00" };
  }
  if (stake === null || stake < 0) {
    return { ...base, price, invalid: true, invalidReason: "Enter a stake of $0 or more" };
  }

  // A $0 stake is legitimate — it just buys nothing. Break-even probability is still meaningful.
  if (stake === 0) {
    return {
      stake: 0,
      price,
      shares: 0,
      grossPayout: 0,
      profit: 0,
      lossIfWrong: 0,
      returnPct: null,
      breakEvenProbability: price,
      invalid: false,
      invalidReason: null,
    };
  }

  const shares = stake / price;
  const grossPayout = shares; // each share settles at exactly $1
  const profit = grossPayout - stake;

  // A huge stake divided by a tiny price can overflow to Infinity even though both inputs were
  // individually finite. Check the results, not just the arguments.
  if (!Number.isFinite(shares) || !Number.isFinite(grossPayout) || !Number.isFinite(profit)) {
    return { ...base, price, invalid: true, invalidReason: "Stake is too large for this price" };
  }

  return {
    stake,
    price,
    shares,
    grossPayout,
    profit,
    lossIfWrong: stake,
    returnPct: profit / stake,
    breakEvenProbability: price,
    invalid: false,
    invalidReason: null,
  };
}

/** Payout figures for a $1 stake — the comparable unit used across opportunity cards. */
export function payoutPerDollar(price: unknown): PayoutResult {
  return calculatePayout(1, price);
}

/**
 * Expected value per share at an assumed probability.
 *
 *   EV per share = assumedProbability − price
 *
 * This is a MODEL ESTIMATE conditional on the assumed probability being right. It is not an edge
 * that has been demonstrated to exist.
 */
export interface ExpectedValueResult {
  evPerShare: number | null;
  evPerDollar: number | null;
  /** EV per dollar staked, i.e. return on capital if the estimate were correct. */
  returnOnCapital: number | null;
  edgePoints: number | null;
}

export function calculateExpectedValue(
  assumedProbability: unknown,
  priceInput: unknown,
): ExpectedValueResult {
  const probability = safeNumber(assumedProbability);
  const price = safeNumber(priceInput);

  if (probability === null || price === null || price <= 0 || price >= 1) {
    return { evPerShare: null, evPerDollar: null, returnOnCapital: null, edgePoints: null };
  }
  if (probability < 0 || probability > 1) {
    return { evPerShare: null, evPerDollar: null, returnOnCapital: null, edgePoints: null };
  }

  const evPerShare = probability - price;
  // One dollar buys 1/price shares, so EV per dollar staked scales by that.
  const evPerDollar = evPerShare / price;

  return {
    evPerShare,
    evPerDollar,
    returnOnCapital: evPerDollar,
    edgePoints: (probability - price) * 100,
  };
}

/**
 * Small-bankroll context. Reports what a hypothetical stake represents as a share of bankroll.
 * It deliberately does NOT recommend a stake size — no Kelly, no "optimal" bet.
 */
export interface BankrollExposure {
  stake: number;
  fractionOfBankroll: number | null;
  severity: "low" | "moderate" | "high" | "extreme";
}

export function bankrollExposure(stakeInput: unknown, bankrollInput: unknown): BankrollExposure {
  const stake = safeNumber(stakeInput) ?? 0;
  const bankroll = safeNumber(bankrollInput);

  if (bankroll === null || bankroll <= 0) {
    return { stake, fractionOfBankroll: null, severity: "low" };
  }

  const fraction = stake / bankroll;
  let severity: BankrollExposure["severity"] = "low";
  if (fraction >= 0.5) severity = "extreme";
  else if (fraction >= 0.25) severity = "high";
  else if (fraction >= 0.1) severity = "moderate";

  return { stake, fractionOfBankroll: fraction, severity };
}

/** The quick-stake buttons. "ALL" only ever computes — it can never place an order. */
export function quickStakes(bankroll: number | null): Array<{ label: string; amount: number }> {
  const safeBankroll = safeNumber(bankroll);
  const stakes = [
    { label: "$0.25", amount: 0.25 },
    { label: "$0.50", amount: 0.5 },
    { label: "$1", amount: 1 },
    { label: "$2", amount: 2 },
  ];
  if (safeBankroll !== null && safeBankroll > 0) {
    stakes.push({ label: "ALL", amount: safeBankroll });
  }
  return stakes;
}
