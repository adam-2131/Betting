import { describe, expect, it } from "vitest";
import { computeOverround, findLegSet, type LegMarket } from "./leg-set";

function leg(overrides: Partial<LegMarket> = {}): LegMarket {
  return {
    id: "m1",
    question: "Will Vissel Kōbe win on 2026-09-11?",
    outcomes: ["Yes", "No"],
    prices: [0.365, 0.635],
    bestAsk: 0.37,
    spread: 0.01,
    sportsMarketType: "moneyline",
    negRisk: false,
    ...overrides,
  };
}

/** The Vissel Kōbe vs. Kashima Antlers three-way, verbatim from a live sync. */
const MATCH_RESULT: LegMarket[] = [
  leg({ id: "draw", question: "Will Vissel Kōbe vs. Kashima Antlers end in a draw?", prices: [0.295, 0.705], bestAsk: 0.3 }),
  leg({ id: "away", question: "Will Kashima Antlers win on 2026-09-11?", prices: [0.345, 0.655], bestAsk: 0.35 }),
  leg({ id: "home", question: "Will Vissel Kōbe win on 2026-09-11?", prices: [0.365, 0.635], bestAsk: 0.37 }),
];

describe("findLegSet — refuses far more often than it accepts", () => {
  it("recognises the home/draw/away shape", () => {
    const set = findLegSet(MATCH_RESULT);
    expect(set?.kind).toBe("MATCH_RESULT");
    expect(set?.legs).toHaveLength(3);
  });

  it("recognises a negative-risk event, which is mutually exclusive by construction", () => {
    const legs = Array.from({ length: 4 }, (_, i) =>
      leg({ id: `d${i}`, negRisk: true, sportsMarketType: null, prices: [0.25, 0.75] }),
    );
    expect(findLegSet(legs)?.kind).toBe("NEG_RISK");
  });

  it("refuses an event of unrelated markets about the same match", () => {
    // THE CASE THIS GUARD EXISTS FOR. A live Counter-Strike event held eleven markets — map
    // handicaps, map winners, round totals — whose outcome-0 prices summed to 4.97. Summing them
    // would report 397% of vig.
    const esports: LegMarket[] = [
      leg({ id: "ml", outcomes: ["FURIA", "G2"], prices: [0.545, 0.455], sportsMarketType: "moneyline" }),
      leg({ id: "h1", outcomes: ["FURIA", "G2"], prices: [0.335, 0.665], sportsMarketType: "round_handicap_game_1" }),
      leg({ id: "t1", outcomes: ["Over", "Under"], prices: [0.495, 0.505], sportsMarketType: "round_over_under_game_1" }),
      leg({ id: "m1w", outcomes: ["FURIA", "G2"], prices: [0.515, 0.485], sportsMarketType: "child_moneyline" }),
    ];
    expect(findLegSet(esports)).toBeNull();
    expect(computeOverround(esports)).toBeNull();
  });

  it("refuses a moneyline set whose outcomes are teams rather than Yes/No", () => {
    // A two-outcome team moneyline already sums to 1 inside itself; there is no set to compare.
    const teams = [
      leg({ id: "a", outcomes: ["Bills", "Texans"], prices: [0.525, 0.475] }),
      leg({ id: "b", outcomes: ["Bears", "Panthers"], prices: [0.4, 0.6] }),
    ];
    expect(findLegSet(teams)).toBeNull();
  });

  it("refuses a mixed set where only some legs are negative-risk", () => {
    expect(
      findLegSet([leg({ negRisk: true, sportsMarketType: null }), leg({ negRisk: false, sportsMarketType: null })]),
    ).toBeNull();
  });

  it("refuses a single market", () => {
    expect(findLegSet([leg()])).toBeNull();
    expect(findLegSet([])).toBeNull();
  });

  it("refuses four or more match-result legs, which is not a game shape", () => {
    expect(findLegSet(Array.from({ length: 4 }, (_, i) => leg({ id: `l${i}` })))).toBeNull();
  });
});

describe("computeOverround", () => {
  it("measures the cut on a real three-way", () => {
    const result = computeOverround(MATCH_RESULT);
    // 0.295 + 0.345 + 0.365
    expect(result?.midSum).toBeCloseTo(1.005, 10);
    expect(result?.midOverroundPoints).toBeCloseTo(0.5, 6);
    // 0.30 + 0.35 + 0.37 — what covering the game actually costs.
    expect(result?.askSum).toBeCloseTo(1.02, 10);
    expect(result?.askOverroundPoints).toBeCloseTo(2, 6);
  });

  it("reports an underround as a negative number rather than clamping it", () => {
    // A live 24-leg F1 championship summed to 0.965.
    const legs = Array.from({ length: 4 }, (_, i) =>
      leg({ id: `d${i}`, negRisk: true, sportsMarketType: null, prices: [0.24, 0.76], bestAsk: 0.25 }),
    );
    const result = computeOverround(legs);
    expect(result?.midSum).toBeCloseTo(0.96, 10);
    expect(result?.midOverroundPoints).toBeCloseTo(-4, 6);
  });

  it("withholds the ask sum when a leg is too wide to be a real quote", () => {
    // On the same F1 market most legs sit near zero and unquoted; their nominal asks summed to
    // 10.98, which describes an absent book rather than the cost of anything.
    const legs = [
      leg({ id: "a", negRisk: true, sportsMarketType: null, spread: 0.01 }),
      leg({ id: "b", negRisk: true, sportsMarketType: null, spread: 0.5, bestAsk: 0.5 }),
    ];
    const result = computeOverround(legs);
    expect(result?.midSum).toBeGreaterThan(0);
    expect(result?.askSum).toBeNull();
    expect(result?.askOverroundPoints).toBeNull();
  });

  it("does not use bestAsk for a leg whose Yes is not outcome 0", () => {
    // bestAsk describes outcome 0 only, so a flipped leg has no usable ask.
    const legs = [
      leg({ id: "a", outcomes: ["No", "Yes"], prices: [0.7, 0.3] }),
      leg({ id: "b" }),
    ];
    const result = computeOverround(legs);
    expect(result?.midSum).toBeCloseTo(0.3 + 0.365, 10);
    expect(result?.askSum).toBeNull();
  });

  it("strips the question wrapper for display", () => {
    const result = computeOverround(MATCH_RESULT);
    expect(result?.legs.map((l) => l.label)).toContain("Vissel Kōbe win on 2026-09-11");
  });

  it("returns null rather than a partial sum when a leg has no price", () => {
    const legs = [leg({ id: "a", prices: [] }), leg({ id: "b" }), leg({ id: "c" })];
    expect(computeOverround(legs)).toBeNull();
  });
});
