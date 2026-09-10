/**
 * SPLITTING A BANKROLL — not optimising one.
 *
 * The distinction matters and is deliberate.
 *
 * The textbook answer to "how much should I put on this?" is the Kelly criterion, which sizes a
 * stake in proportion to your edge. With no edge, Kelly returns zero. Our own backtest found no
 * reliable relationship between the Opportunity Score and outcomes — rank correlation at or below
 * zero at every horizon tested, and no score band beating its own prices by more than chance
 * produces. Sizing positions by that score would be optimising against a number we cannot justify,
 * and it would produce confident-looking dollar amounts built on nothing.
 *
 * So this module does something narrower and defensible. It assumes you have already decided to
 * commit a sum, and its job is purely mechanical: divide that sum across positions so that no
 * single outcome can do disproportionate damage, while respecting the constraint that Polymarket
 * will not accept an order below $1.
 *
 * Equal weighting is the default for a specific reason, not out of timidity: when you cannot rank
 * candidates reliably, equal weighting is the allocation that assumes least. Score weighting is
 * offered because it was asked for, and it carries a warning wherever it is used.
 *
 * THE $1 MINIMUM is the interesting constraint here. It is a hard floor per order, which means a
 * bankroll of $7 can occupy at most 7 positions, and a "spread it thin" instinct stops working
 * quickly. Positions that would receive less than $1 are dropped and their money redistributed
 * rather than being silently rounded up, which would overspend the bankroll.
 */

export type AllocationMethod = "EQUAL" | "SCORE_WEIGHTED";

export interface AllocationCandidate {
  id: string;
  question: string;
  outcomeLabel: string;
  /** 0..1 exclusive. Anything else is unusable and the candidate is dropped. */
  price: number | null;
  score: number | null;
  entryGapCents: number | null;
  liquidity: number | null;
}

export interface AllocationRequest {
  bankrollUsd: number;
  candidates: AllocationCandidate[];
  method: AllocationMethod;
  /** Upper bound on how many positions to split across. */
  maxPositions: number;
  /** Polymarket will not accept an order below this. */
  minTicketUsd?: number;
  /** No single position may exceed this share of the bankroll, where the $1 floor allows. */
  maxSharePct?: number;
}

export interface AllocationLine {
  id: string;
  question: string;
  outcomeLabel: string;
  price: number;
  score: number | null;
  entryGapCents: number | null;
  stakeUsd: number;
  shares: number;
  /** Gross return if this outcome resolves in your favour; shares pay $1 each. */
  payoutIfWins: number;
  profitIfWins: number;
  pctOfBankroll: number;
}

export interface AllocationPlan {
  lines: AllocationLine[];
  totalStaked: number;
  /** Money the $1 floor made unusable. Reported, never quietly absorbed. */
  unallocated: number;
  /** Ceiling imposed by the $1 minimum alone. */
  positionsPossible: number;
  /** Gross return if every position resolves your way. Not a forecast — the best case. */
  payoutIfAllWin: number;
  /** What you lose if none do. Always the full staked amount. */
  lossIfAllLose: number;
  /**
   * What the plan returns on average *if the market's prices are right*.
   *
   * This is the number that stops `payoutIfAllWin` from being read as a forecast. It comes out
   * equal to the amount staked, and not by coincidence: a share bought at price p pays $1 with
   * probability p, so its expected value is exactly what it cost. Every plan built from market
   * prices breaks even on paper, and beating that requires the prices to be wrong in your
   * favour — which is precisely what the backtest could not demonstrate.
   */
  expectedPayoutAtMarketPrices: number;
  /** Market-implied chance that at least one position pays. Independence assumed — see notes. */
  chanceAtLeastOneWins: number | null;
  /** Market-implied chance the best case actually happens. Usually very small. */
  chanceAllWin: number | null;
  notes: string[];
  warnings: string[];
}

const DEFAULT_MIN_TICKET = 1;
const DEFAULT_MAX_SHARE_PCT = 40;

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function usable(candidate: AllocationCandidate): boolean {
  const price = candidate.price;
  return price !== null && Number.isFinite(price) && price > 0 && price < 1;
}

/**
 * Distributes weights subject to a per-position ceiling.
 *
 * Clamping one weight pushes the rest up, which can push another over the ceiling, so this
 * iterates. It converges because each pass either clamps a new position or changes nothing.
 *
 * The ceiling is raised to `1/n` first, because a ceiling below that is arithmetically
 * impossible — three positions cannot each be under 25% of the total. Asking for the impossible
 * used to make this invert the ordering outright (a 40% ceiling across two positions handed the
 * *lower*-weighted one 60%), so an infeasible ceiling now degrades to an even split, which is the
 * closest thing to it that exists.
 */
function capWeights(weights: number[], requestedMaxShare: number): number[] {
  const result = [...weights];
  if (result.length === 0) return result;

  const maxShare = Math.max(requestedMaxShare, 1 / result.length);
  const capped = new Array<boolean>(weights.length).fill(false);

  for (let pass = 0; pass < weights.length; pass++) {
    const overflowIndex = result.findIndex((w, i) => !capped[i] && w > maxShare + 1e-9);
    if (overflowIndex === -1) break;

    const excess = result[overflowIndex] - maxShare;
    result[overflowIndex] = maxShare;
    capped[overflowIndex] = true;

    const freeIndices = result.map((_, i) => i).filter((i) => !capped[i]);
    const freeTotal = freeIndices.reduce((acc, i) => acc + result[i], 0);
    if (freeIndices.length === 0 || freeTotal <= 0) {
      // Nowhere left to put the excess; the ceiling cannot be honoured for this bankroll.
      result[overflowIndex] += excess;
      break;
    }
    for (const i of freeIndices) result[i] += excess * (result[i] / freeTotal);
  }

  return result;
}

export function buildAllocationPlan(request: AllocationRequest): AllocationPlan {
  const minTicket = request.minTicketUsd ?? DEFAULT_MIN_TICKET;
  const maxSharePct = request.maxSharePct ?? DEFAULT_MAX_SHARE_PCT;
  const bankroll = Number.isFinite(request.bankrollUsd) ? Math.max(0, request.bankrollUsd) : 0;

  const notes: string[] = [];
  const warnings: string[] = [];

  const empty: AllocationPlan = {
    lines: [],
    totalStaked: 0,
    unallocated: round2(bankroll),
    positionsPossible: 0,
    payoutIfAllWin: 0,
    lossIfAllLose: 0,
    expectedPayoutAtMarketPrices: 0,
    chanceAtLeastOneWins: null,
    chanceAllWin: null,
    notes,
    warnings,
  };

  const positionsPossible = Math.floor(bankroll / minTicket);

  if (bankroll <= 0) {
    notes.push("Enter an amount to see how it would divide.");
    return empty;
  }
  if (positionsPossible < 1) {
    warnings.push(
      `Polymarket will not accept an order below $${minTicket.toFixed(2)}, so $${bankroll.toFixed(2)} cannot be placed at all.`,
    );
    return { ...empty, positionsPossible: 0 };
  }

  const pool = request.candidates.filter(usable);
  if (pool.length === 0) {
    warnings.push(
      "None of the current opportunities have a usable price, so there is nothing to divide across.",
    );
    return { ...empty, positionsPossible };
  }

  const wanted = Math.max(1, Math.floor(request.maxPositions));
  const count = Math.min(wanted, positionsPossible, pool.length);

  if (positionsPossible < wanted && positionsPossible < pool.length) {
    notes.push(
      `The $${minTicket.toFixed(2)} order minimum caps this at ${positionsPossible} position${positionsPossible === 1 ? "" : "s"} — $${bankroll.toFixed(2)} simply does not divide further.`,
    );
  }

  // Highest score first. A null score sorts last rather than being treated as zero-and-equal.
  const chosen = [...pool]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, count);

  // --- Weights -------------------------------------------------------------
  let weights: number[];
  if (request.method === "SCORE_WEIGHTED") {
    // A non-finite score is treated as absent, not as a number. `Math.max(0, NaN)` is NaN, and
    // one of those poisons the whole weight vector.
    const scores = chosen.map((c) =>
      c.score !== null && Number.isFinite(c.score) ? Math.max(0, c.score) : 0,
    );
    const total = scores.reduce((acc, s) => acc + s, 0);
    if (total <= 0) {
      weights = chosen.map(() => 1 / chosen.length);
      notes.push("No usable scores, so this fell back to an equal split.");
    } else {
      weights = scores.map((s) => s / total);
    }
    warnings.push(
      "Score weighting puts more money behind higher-scoring positions, but backtesting has not shown that a higher score leads to a better outcome. This weighting reflects the score's confidence, not any measured accuracy.",
    );
  } else {
    weights = chosen.map(() => 1 / chosen.length);
  }

  weights = capWeights(weights, maxSharePct / 100);

  // --- Money, honouring the floor -----------------------------------------
  // Positions falling under the minimum are removed and the money re-spread, because rounding
  // them up would spend more than the bankroll.
  let active = chosen.map((candidate, i) => ({ candidate, weight: weights[i] }));

  for (let pass = 0; pass < chosen.length; pass++) {
    const weightTotal = active.reduce((acc, a) => acc + a.weight, 0);
    if (weightTotal <= 0) break;

    const short = active.filter((a) => (bankroll * a.weight) / weightTotal < minTicket - 1e-9);
    if (short.length === 0 || active.length <= 1) break;

    // Drop the single smallest each pass so the survivors keep their relative ordering.
    const smallest = short.reduce((worst, a) => (a.weight < worst.weight ? a : worst), short[0]);
    active = active.filter((a) => a !== smallest);
  }

  if (active.length === 0) {
    warnings.push("No position could be funded to the order minimum.");
    return { ...empty, positionsPossible };
  }

  if (active.length < chosen.length) {
    notes.push(
      `${chosen.length - active.length} position${chosen.length - active.length === 1 ? "" : "s"} dropped because ${chosen.length - active.length === 1 ? "its" : "their"} share came to less than the $${minTicket.toFixed(2)} minimum. That money went to the rest rather than being rounded up.`,
    );
  }

  const weightTotal = active.reduce((acc, a) => acc + a.weight, 0);
  const stakes = active.map((a) => round2((bankroll * a.weight) / weightTotal));

  // Cent-level rounding drift lands on the largest position, so the plan sums to the bankroll
  // exactly rather than being a few cents out.
  const drift = round2(bankroll - stakes.reduce((acc, s) => acc + s, 0));
  if (Math.abs(drift) >= 0.01) {
    let largest = 0;
    for (let i = 1; i < stakes.length; i++) if (stakes[i] > stakes[largest]) largest = i;
    const adjusted = round2(stakes[largest] + drift);
    if (adjusted >= minTicket) stakes[largest] = adjusted;
  }

  const lines: AllocationLine[] = active.map((a, i) => {
    const price = a.candidate.price as number;
    const stakeUsd = stakes[i];
    const shares = stakeUsd / price;
    const payoutIfWins = shares; // each share settles at $1
    return {
      id: a.candidate.id,
      question: a.candidate.question,
      outcomeLabel: a.candidate.outcomeLabel,
      price,
      score: a.candidate.score,
      entryGapCents: a.candidate.entryGapCents,
      stakeUsd,
      shares: round2(shares),
      payoutIfWins: round2(payoutIfWins),
      profitIfWins: round2(payoutIfWins - stakeUsd),
      pctOfBankroll: bankroll > 0 ? round2((stakeUsd / bankroll) * 100) : 0,
    };
  });

  const totalStaked = round2(lines.reduce((acc, l) => acc + l.stakeUsd, 0));

  // --- Notes and warnings --------------------------------------------------
  notes.push(
    request.method === "EQUAL"
      ? `Split evenly across ${lines.length} position${lines.length === 1 ? "" : "s"}. Even weighting is the split that assumes least about which of these is better — which matches what the backtest can actually support.`
      : `Weighted by score across ${lines.length} position${lines.length === 1 ? "" : "s"}.`,
  );

  if (lines.length === 1) {
    warnings.push(
      "Everything is in a single position, so this is one bet rather than a spread. If it loses, the whole amount is gone.",
    );
  } else {
    const biggest = lines.reduce((worst, l) => (l.pctOfBankroll > worst.pctOfBankroll ? l : worst), lines[0]);
    if (biggest.pctOfBankroll > maxSharePct + 1) {
      warnings.push(
        `The largest position is ${biggest.pctOfBankroll.toFixed(0)}% of the total, above the ${maxSharePct}% ceiling. With this bankroll the $${minTicket.toFixed(2)} minimum leaves no way to spread it thinner.`,
      );
    }
  }

  const unallocated = round2(bankroll - totalStaked);
  if (unallocated >= 0.01) {
    notes.push(`$${unallocated.toFixed(2)} is left over — too little to meet the order minimum.`);
  }

  // --- What the market thinks of the plan ----------------------------------
  // Prices are read as probabilities here. That is the market's own view, not ours, and it is
  // the only probability in this application we have any basis for quoting.
  const expectedPayout = lines.reduce((acc, l) => acc + l.shares * l.price, 0);
  const chanceAllWin = lines.reduce((acc, l) => acc * l.price, 1);
  const chanceNoneWin = lines.reduce((acc, l) => acc * (1 - l.price), 1);
  const chanceAtLeastOneWins = 1 - chanceNoneWin;

  if (lines.length > 1) {
    notes.push(
      `At the market's own prices this plan is expected to return about $${expectedPayout.toFixed(2)} on $${totalStaked.toFixed(2)} staked — roughly break-even. That is true of any basket bought at market: a share costing ${(lines[0].price * 100).toFixed(0)}¢ pays $1 about ${(lines[0].price * 100).toFixed(0)}% of the time. Coming out ahead needs the prices to be wrong, and nothing here establishes that they are.`,
    );
    notes.push(
      `Treating each market as independent, there is roughly a ${(chanceAtLeastOneWins * 100).toFixed(0)}% chance at least one of these pays, and about a ${formatSmallPercent(chanceAllWin)} chance they all do. Markets covering the same event are not actually independent, so read these as rough.`,
    );
  }

  const medianPrice = [...lines].sort((a, b) => a.price - b.price)[Math.floor(lines.length / 2)]?.price;
  if (lines.length > 1 && medianPrice !== undefined && medianPrice < 0.15) {
    warnings.push(
      `Most of this is going into longshots — the typical position here costs ${(medianPrice * 100).toFixed(0)}¢, meaning the market expects it to lose about ${((1 - medianPrice) * 100).toFixed(0)}% of the time. The large "if it wins" figures are the reason those prices are low, not a sign of value. Expect most of these to expire worthless.`,
    );
  }

  return {
    lines,
    totalStaked,
    unallocated: Math.max(0, unallocated),
    positionsPossible,
    payoutIfAllWin: round2(lines.reduce((acc, l) => acc + l.payoutIfWins, 0)),
    lossIfAllLose: totalStaked,
    expectedPayoutAtMarketPrices: round2(expectedPayout),
    chanceAtLeastOneWins,
    chanceAllWin,
    notes,
    warnings,
  };
}

/** Keeps a tiny probability legible instead of rendering it as a flat "0%". */
function formatSmallPercent(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0%";
  const pct = p * 100;
  if (pct >= 1) return `${pct.toFixed(0)}%`;
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  return "far below 1%";
}

/**
 * The reason this is a splitter and not an optimiser, stated once so the UI and the docs agree.
 */
export const WHY_NOT_OPTIMISED =
  "This divides an amount you have already decided to commit. It is not an optimiser: the usual way to size a position is the Kelly criterion, which scales a stake to your edge and returns zero when there is no edge — and backtesting has not demonstrated an edge here. Any tool claiming an optimal amount would be inventing the number it optimises against.";
