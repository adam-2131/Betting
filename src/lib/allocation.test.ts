import { describe, expect, it } from "vitest";
import {
  buildAllocationPlan,
  WHY_NOT_OPTIMISED,
  type AllocationCandidate,
  type AllocationRequest,
} from "./allocation";

function candidate(overrides: Partial<AllocationCandidate> = {}): AllocationCandidate {
  return {
    id: "c1",
    question: "Will something happen?",
    outcomeLabel: "Yes",
    price: 0.5,
    score: 60,
    entryGapCents: 2,
    liquidity: 5000,
    ...overrides,
  };
}

function candidates(n: number, scoreFrom = 90): AllocationCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    candidate({ id: `c${i}`, score: scoreFrom - i * 5, price: 0.5 }),
  );
}

function request(overrides: Partial<AllocationRequest> = {}): AllocationRequest {
  return {
    bankrollUsd: 20,
    candidates: candidates(5),
    method: "EQUAL",
    maxPositions: 5,
    ...overrides,
  };
}

describe("the $1 order minimum", () => {
  it("caps the number of positions at the bankroll in whole dollars", () => {
    const plan = buildAllocationPlan(request({ bankrollUsd: 3, maxPositions: 10, candidates: candidates(10) }));
    expect(plan.positionsPossible).toBe(3);
    expect(plan.lines).toHaveLength(3);
    for (const line of plan.lines) expect(line.stakeUsd).toBeGreaterThanOrEqual(1);
  });

  it("refuses to place anything below the minimum", () => {
    const plan = buildAllocationPlan(request({ bankrollUsd: 0.6 }));
    expect(plan.lines).toHaveLength(0);
    expect(plan.positionsPossible).toBe(0);
    expect(plan.warnings.join(" ")).toContain("will not accept an order below");
  });

  it("funds exactly one position at exactly the minimum", () => {
    const plan = buildAllocationPlan(request({ bankrollUsd: 1, maxPositions: 5 }));
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].stakeUsd).toBe(1);
    expect(plan.totalStaked).toBe(1);
  });

  it("drops underfunded positions instead of rounding them up past the bankroll", () => {
    // 5 ways from $7 would be $1.40 each, which is fine; 10 ways would be $0.70, which is not.
    const plan = buildAllocationPlan(
      request({ bankrollUsd: 7, maxPositions: 10, candidates: candidates(10) }),
    );
    expect(plan.lines.length).toBeLessThanOrEqual(7);
    expect(plan.totalStaked).toBeLessThanOrEqual(7);
    for (const line of plan.lines) expect(line.stakeUsd).toBeGreaterThanOrEqual(1);
  });

  it("never spends more than the bankroll, across many awkward amounts", () => {
    for (const bankrollUsd of [1, 1.01, 2.5, 3.33, 7, 9.99, 12.5, 100, 1000.07]) {
      for (const maxPositions of [1, 3, 5, 8]) {
        const plan = buildAllocationPlan(
          request({ bankrollUsd, maxPositions, candidates: candidates(8) }),
        );
        expect(plan.totalStaked).toBeLessThanOrEqual(bankrollUsd + 1e-9);
        expect(plan.totalStaked + plan.unallocated).toBeCloseTo(bankrollUsd, 2);
      }
    }
  });

  it("reports leftover money rather than absorbing it", () => {
    const plan = buildAllocationPlan(
      request({ bankrollUsd: 2.5, maxPositions: 5, candidates: candidates(5) }),
    );
    expect(plan.totalStaked + plan.unallocated).toBeCloseTo(2.5, 2);
  });
});

describe("splitting", () => {
  it("divides evenly and sums to the bankroll exactly", () => {
    const plan = buildAllocationPlan(request({ bankrollUsd: 20, maxPositions: 4 }));
    expect(plan.lines).toHaveLength(4);
    expect(plan.totalStaked).toBe(20);
    for (const line of plan.lines) expect(line.stakeUsd).toBe(5);
  });

  it("absorbs cent rounding so the total is exact, not a cent short", () => {
    // $10 across 3 is $3.333…, which cannot be represented in cents.
    const plan = buildAllocationPlan(request({ bankrollUsd: 10, maxPositions: 3 }));
    expect(plan.totalStaked).toBe(10);
    expect(plan.lines.reduce((acc, l) => acc + l.stakeUsd, 0)).toBeCloseTo(10, 2);
  });

  it("picks the highest scoring candidates when it cannot take them all", () => {
    const plan = buildAllocationPlan(
      request({ bankrollUsd: 20, maxPositions: 2, candidates: candidates(6) }),
    );
    expect(plan.lines.map((l) => l.id)).toEqual(["c0", "c1"]);
  });

  it("puts more behind higher scores when asked, and says why that is weak", () => {
    const plan = buildAllocationPlan(
      request({
        bankrollUsd: 100,
        method: "SCORE_WEIGHTED",
        maxPositions: 4,
        candidates: [
          candidate({ id: "a", score: 90 }),
          candidate({ id: "b", score: 60 }),
          candidate({ id: "c", score: 40 }),
          candidate({ id: "d", score: 20 }),
        ],
      }),
    );

    const stakes = ["a", "b", "c", "d"].map((id) => plan.lines.find((l) => l.id === id)!.stakeUsd);
    for (let i = 1; i < stakes.length; i++) {
      expect(stakes[i - 1]).toBeGreaterThan(stakes[i]);
    }
    expect(plan.warnings.join(" ")).toContain("has not shown that a higher score leads to a better outcome");
  });

  it("degrades an impossible concentration ceiling to an even split rather than inverting it", () => {
    // Two positions cannot each be under 40% of the total. The ceiling has to give way, and the
    // way it gives way must not end up favouring the weaker candidate.
    const plan = buildAllocationPlan(
      request({
        bankrollUsd: 100,
        method: "SCORE_WEIGHTED",
        maxPositions: 2,
        maxSharePct: 40,
        candidates: [candidate({ id: "hi", score: 90 }), candidate({ id: "lo", score: 30 })],
      }),
    );

    const hi = plan.lines.find((l) => l.id === "hi")!;
    const lo = plan.lines.find((l) => l.id === "lo")!;
    expect(hi.stakeUsd).toBeGreaterThanOrEqual(lo.stakeUsd);
    expect(hi.stakeUsd).toBe(50);
    expect(lo.stakeUsd).toBe(50);
  });

  it("falls back to an equal split when no scores are usable", () => {
    const plan = buildAllocationPlan(
      request({
        bankrollUsd: 20,
        method: "SCORE_WEIGHTED",
        maxPositions: 2,
        candidates: [candidate({ id: "a", score: 0 }), candidate({ id: "b", score: null })],
      }),
    );
    expect(plan.lines[0].stakeUsd).toBe(plan.lines[1].stakeUsd);
    expect(plan.notes.join(" ")).toContain("fell back to an equal split");
  });

  it("holds a concentration ceiling when the bankroll allows it", () => {
    const plan = buildAllocationPlan(
      request({
        bankrollUsd: 1000,
        method: "SCORE_WEIGHTED",
        maxPositions: 4,
        maxSharePct: 40,
        candidates: [
          candidate({ id: "huge", score: 100 }),
          candidate({ id: "b", score: 5 }),
          candidate({ id: "c", score: 5 }),
          candidate({ id: "d", score: 5 }),
        ],
      }),
    );

    const biggest = Math.max(...plan.lines.map((l) => l.pctOfBankroll));
    expect(biggest).toBeLessThanOrEqual(41);
  });

  it("says so when the minimum makes the ceiling impossible", () => {
    // $2 can only be two $1 tickets, so each is 50% however much you want a 40% cap.
    const plan = buildAllocationPlan(
      request({ bankrollUsd: 2, maxPositions: 5, maxSharePct: 40, candidates: candidates(5) }),
    );
    expect(plan.warnings.join(" ")).toContain("no way to spread it thinner");
  });

  it("warns plainly when everything lands on one position", () => {
    const plan = buildAllocationPlan(request({ bankrollUsd: 50, maxPositions: 1 }));
    expect(plan.lines).toHaveLength(1);
    expect(plan.warnings.join(" ")).toContain("the whole amount is gone");
  });
});

describe("the payout arithmetic", () => {
  it("converts a stake into shares at the quoted price", () => {
    const plan = buildAllocationPlan(
      request({ bankrollUsd: 10, maxPositions: 1, candidates: [candidate({ price: 0.25 })] }),
    );
    const line = plan.lines[0];
    expect(line.stakeUsd).toBe(10);
    expect(line.shares).toBe(40);
    expect(line.payoutIfWins).toBe(40);
    expect(line.profitIfWins).toBe(30);
  });

  it("reports the best and worst case as the two extremes they are", () => {
    const plan = buildAllocationPlan(
      request({ bankrollUsd: 10, maxPositions: 2, candidates: candidates(2) }),
    );
    expect(plan.lossIfAllLose).toBe(plan.totalStaked);
    expect(plan.payoutIfAllWin).toBeGreaterThan(plan.totalStaked);
  });

  it("makes no profit on a 99c near-certainty, which is the point", () => {
    const plan = buildAllocationPlan(
      request({ bankrollUsd: 100, maxPositions: 1, candidates: [candidate({ price: 0.99 })] }),
    );
    expect(plan.lines[0].profitIfWins).toBeCloseTo(1.01, 1);
  });
});

describe("what the market thinks of the plan", () => {
  it("comes out break-even at market prices, whatever the split", () => {
    // A share bought at p pays $1 with probability p, so its expected value is what it cost.
    // Any plan assembled at market prices must therefore return its own stake on paper.
    for (const method of ["EQUAL", "SCORE_WEIGHTED"] as const) {
      const plan = buildAllocationPlan(
        request({
          bankrollUsd: 100,
          method,
          maxPositions: 4,
          candidates: [
            candidate({ id: "a", price: 0.05, score: 80 }),
            candidate({ id: "b", price: 0.42, score: 70 }),
            candidate({ id: "c", price: 0.61, score: 60 }),
            candidate({ id: "d", price: 0.88, score: 50 }),
          ],
        }),
      );
      expect(plan.expectedPayoutAtMarketPrices).toBeCloseTo(plan.totalStaked, 1);
    }
  });

  it("computes the chance at least one pays", () => {
    const plan = buildAllocationPlan(
      request({
        bankrollUsd: 10,
        maxPositions: 2,
        candidates: [candidate({ id: "a", price: 0.5 }), candidate({ id: "b", price: 0.5 })],
      }),
    );
    // 1 - 0.5 * 0.5
    expect(plan.chanceAtLeastOneWins).toBeCloseTo(0.75, 6);
    expect(plan.chanceAllWin).toBeCloseTo(0.25, 6);
  });

  it("keeps both probabilities inside [0, 1]", () => {
    for (const price of [0.001, 0.05, 0.5, 0.95, 0.999]) {
      const plan = buildAllocationPlan(
        request({ bankrollUsd: 20, maxPositions: 4, candidates: candidates(4).map((c) => ({ ...c, price })) }),
      );
      expect(plan.chanceAtLeastOneWins).toBeGreaterThanOrEqual(0);
      expect(plan.chanceAtLeastOneWins).toBeLessThanOrEqual(1);
      expect(plan.chanceAllWin).toBeGreaterThanOrEqual(0);
      expect(plan.chanceAllWin).toBeLessThanOrEqual(1);
    }
  });

  it("warns when the basket is mostly longshots", () => {
    const plan = buildAllocationPlan(
      request({
        bankrollUsd: 20,
        maxPositions: 4,
        candidates: candidates(4).map((c) => ({ ...c, price: 0.04 })),
      }),
    );
    const warned = plan.warnings.join(" ");
    expect(warned).toContain("longshots");
    expect(warned).toContain("expire worthless");
  });

  it("does not cry longshot over a normally priced basket", () => {
    const plan = buildAllocationPlan(
      request({
        bankrollUsd: 20,
        maxPositions: 4,
        candidates: candidates(4).map((c) => ({ ...c, price: 0.55 })),
      }),
    );
    expect(plan.warnings.join(" ")).not.toContain("longshots");
  });

  it("says the break-even truth rather than selling the best case", () => {
    const plan = buildAllocationPlan(request({ bankrollUsd: 20, maxPositions: 3 }));
    const said = plan.notes.join(" ");
    expect(said).toContain("roughly break-even");
    expect(said).toContain("needs the prices to be wrong");
  });

  it("renders a vanishing best case as words, never a bare 0%", () => {
    const plan = buildAllocationPlan(
      request({
        bankrollUsd: 20,
        maxPositions: 6,
        candidates: candidates(6).map((c) => ({ ...c, price: 0.02 })),
      }),
    );
    expect(plan.chanceAllWin).toBeGreaterThan(0);
    expect(plan.notes.join(" ")).toContain("far below 1%");
  });
});

describe("bad input", () => {
  it("drops candidates whose price cannot be traded", () => {
    const plan = buildAllocationPlan(
      request({
        bankrollUsd: 20,
        maxPositions: 5,
        candidates: [
          candidate({ id: "ok", price: 0.4 }),
          candidate({ id: "zero", price: 0 }),
          candidate({ id: "one", price: 1 }),
          candidate({ id: "nan", price: Number.NaN }),
          candidate({ id: "null", price: null }),
          candidate({ id: "neg", price: -0.2 }),
        ],
      }),
    );
    expect(plan.lines.map((l) => l.id)).toEqual(["ok"]);
  });

  it("returns an empty plan rather than throwing when nothing is usable", () => {
    const plan = buildAllocationPlan(
      request({ candidates: [candidate({ price: null }), candidate({ price: 1 })] }),
    );
    expect(plan.lines).toHaveLength(0);
    expect(plan.warnings.join(" ")).toContain("nothing to divide across");
  });

  it("handles a zero, negative or non-finite bankroll", () => {
    for (const bankrollUsd of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = buildAllocationPlan(request({ bankrollUsd }));
      expect(plan.lines).toHaveLength(0);
      expect(plan.totalStaked).toBe(0);
    }
  });

  it("handles an empty candidate list", () => {
    const plan = buildAllocationPlan(request({ candidates: [] }));
    expect(plan.lines).toHaveLength(0);
    expect(plan.totalStaked).toBe(0);
  });

  it("never emits NaN or Infinity into any number it reports", () => {
    const awkward: Array<Partial<AllocationRequest>> = [
      { bankrollUsd: 1e9, maxPositions: 3 },
      { bankrollUsd: 1.004, maxPositions: 2 },
      { bankrollUsd: 7, maxPositions: 100, candidates: candidates(100) },
      { bankrollUsd: 7, maxPositions: 0 },
      { bankrollUsd: 7, maxPositions: -3 },
      { bankrollUsd: 5, candidates: [candidate({ price: 0.0001 })] },
      { bankrollUsd: 5, candidates: [candidate({ price: 0.9999 })] },
      { bankrollUsd: 5, method: "SCORE_WEIGHTED", candidates: [candidate({ score: Number.NaN })] },
    ];

    for (const overrides of awkward) {
      const plan = buildAllocationPlan(request(overrides));
      const numbers = [
        plan.totalStaked,
        plan.unallocated,
        plan.positionsPossible,
        plan.payoutIfAllWin,
        plan.lossIfAllLose,
        plan.expectedPayoutAtMarketPrices,
        ...(plan.chanceAtLeastOneWins === null ? [] : [plan.chanceAtLeastOneWins]),
        ...(plan.chanceAllWin === null ? [] : [plan.chanceAllWin]),
        ...plan.lines.flatMap((l) => [
          l.stakeUsd,
          l.shares,
          l.payoutIfWins,
          l.profitIfWins,
          l.pctOfBankroll,
          l.price,
        ]),
      ];
      for (const value of numbers) {
        expect(Number.isFinite(value)).toBe(true);
      }
      for (const text of [...plan.notes, ...plan.warnings]) {
        expect(text).not.toContain("NaN");
        expect(text).not.toContain("Infinity");
        expect(text).not.toContain("undefined");
      }
    }
  });
});

describe("the language it uses", () => {
  it("never tells the reader to place a trade or promises a result", () => {
    const plan = buildAllocationPlan(request({ bankrollUsd: 20, method: "SCORE_WEIGHTED" }));
    const all = [...plan.notes, ...plan.warnings].join(" ").toLowerCase();
    for (const phrase of ["guaranteed", "you should buy", "sure bet", "can't lose", "risk-free", "optimal stake"]) {
      expect(all).not.toContain(phrase);
    }
  });

  it("explains that an even split is a statement about ignorance, not caution", () => {
    const plan = buildAllocationPlan(request({ bankrollUsd: 20, method: "EQUAL" }));
    expect(plan.notes.join(" ")).toContain("assumes least");
  });

  it("states why there is no optimiser", () => {
    expect(WHY_NOT_OPTIMISED).toContain("Kelly");
    expect(WHY_NOT_OPTIMISED).toContain("returns zero when there is no edge");
    expect(WHY_NOT_OPTIMISED).toContain("not an optimiser");
  });
});
