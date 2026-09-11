import { describe, expect, it } from "vitest";
import {
  describeBet,
  extractLine,
  extractSpreadTeam,
  propositionFromQuestion,
  stakeOutcome,
  type BetInstructionInput,
} from "./bet-instruction";

/** Every question string here is verbatim from a live Polymarket sync. */
function bet(overrides: Partial<BetInstructionInput> = {}): BetInstructionInput {
  return {
    question: "Bills vs. Texans",
    outcomeLabel: "Bills",
    outcomes: ["Bills", "Texans"],
    outcomeIndex: 0,
    sportsMarketType: "moneyline",
    ...overrides,
  };
}

describe("moneyline", () => {
  it("names the team and who it has to beat", () => {
    const result = describeBet(bet());
    expect(result.action).toBe("Bet Bills to win");
    expect(result.winsIf).toBe("Bills beat Texans.");
    expect(result.recognised).toBe(true);
  });

  it("reads the opposing side from the other outcome, not the question", () => {
    const result = describeBet(bet({ outcomeLabel: "Texans", outcomeIndex: 1 }));
    expect(result.action).toBe("Bet Texans to win");
    expect(result.winsIf).toBe("Texans beat Bills.");
  });

  it("qualifies a period market so a 1Q line is never read as full game", () => {
    const result = describeBet(
      bet({ question: "Bills vs. Texans: 1Q Moneyline", sportsMarketType: "q1_moneyline" }),
    );
    expect(result.winsIf).toBe("In Q1, Bills beat Texans.");
  });
});

describe("yes/no markets — the ones that read as gibberish without this", () => {
  it("turns a No on a draw market into a sentence", () => {
    // THE MOTIVATING CASE. '"Will ... end in a draw?" -> No' says nothing on its own.
    const result = describeBet(
      bet({
        question: "Will Venezia FC vs. ACF Fiorentina end in a draw?",
        outcomeLabel: "No",
        outcomes: ["Yes", "No"],
        outcomeIndex: 1,
        sportsMarketType: "moneyline",
      }),
    );
    // The instruction reads as future tense — "will NOT end" — while the settlement conditions
    // read as statements. Both come from one pass over the question.
    expect(result.action).toBe("Bet NO — Venezia FC vs. ACF Fiorentina will NOT end in a draw");
    expect(result.winsIf).toBe("Venezia FC vs. ACF Fiorentina does not end in a draw.");
    expect(result.losesIf).toBe("Venezia FC vs. ACF Fiorentina ends in a draw.");
  });

  it("handles a Yes on a team-win market", () => {
    const result = describeBet(
      bet({
        question: "Will Liverpool FC win on 2026-09-12?",
        outcomeLabel: "Yes",
        outcomes: ["Yes", "No"],
        outcomeIndex: 0,
      }),
    );
    expect(result.action).toBe("Bet YES — Liverpool FC will win on 2026-09-12");
    expect(result.winsIf).toBe("Liverpool FC wins on 2026-09-12.");
  });

  it("handles a non-sports proposition", () => {
    const result = describeBet(
      bet({
        question: "Will Rodri win the 2026 Ballon d'Or?",
        outcomeLabel: "No",
        outcomes: ["Yes", "No"],
        outcomeIndex: 1,
        sportsMarketType: null,
      }),
    );
    expect(result.action).toBe("Bet NO — Rodri will NOT win the 2026 Ballon d'Or");
    expect(result.losesIf).toBe("Rodri wins the 2026 Ballon d'Or.");
  });

  it("falls back honestly when the question is not a 'Will …?' form", () => {
    const result = describeBet(
      bet({
        question: "Recession by year end",
        outcomeLabel: "Yes",
        outcomes: ["Yes", "No"],
        outcomeIndex: 0,
        sportsMarketType: null,
      }),
    );
    expect(result.recognised).toBe(false);
    expect(result.winsIf).toContain("Recession by year end");
  });
});

describe("totals", () => {
  it("states the whole-number threshold rather than repeating the half-point line", () => {
    const result = describeBet(
      bet({
        question: "Bills vs. Texans: O/U 41.5",
        outcomeLabel: "Over",
        outcomes: ["Over", "Under"],
        outcomeIndex: 0,
        sportsMarketType: "totals",
      }),
    );
    expect(result.action).toBe("Bet OVER 41.5 points");
    expect(result.winsIf).toBe("The total is 42 or more points.");
    expect(result.losesIf).toBe("The total is 41 or fewer points.");
  });

  it("mirrors the threshold for the under", () => {
    const result = describeBet(
      bet({
        question: "Bills vs. Texans: O/U 41.5",
        outcomeLabel: "Under",
        outcomes: ["Over", "Under"],
        outcomeIndex: 1,
        sportsMarketType: "totals",
      }),
    );
    expect(result.winsIf).toBe("The total is 41 or fewer points.");
  });

  it("warns about a push when the line is a whole number", () => {
    const result = describeBet(
      bet({
        question: "Bills vs. Texans: O/U 42",
        outcomeLabel: "Over",
        outcomes: ["Over", "Under"],
        outcomeIndex: 0,
        sportsMarketType: "totals",
      }),
    );
    expect(result.losesIf).toContain("push");
  });

  it("qualifies a half or quarter total", () => {
    const result = describeBet(
      bet({
        question: "Bills vs. Texans: 1H O/U 22.5",
        outcomeLabel: "Over",
        outcomes: ["Over", "Under"],
        outcomeIndex: 0,
        sportsMarketType: "first_half_totals",
      }),
    );
    expect(result.winsIf).toBe("In the first half, the total is 23 or more points.");
  });

  it("counts the right thing on a touchdown market", () => {
    const result = describeBet(
      bet({
        question: "Bills Total Touchdowns: O/U 2.5",
        outcomeLabel: "Over",
        outcomes: ["Over", "Under"],
        outcomeIndex: 0,
        sportsMarketType: "team_touchdowns",
      }),
    );
    expect(result.action).toBe("Bet OVER 2.5 touchdowns");
  });
});

describe("spreads — where the quoted line belongs to the other team", () => {
  it("keeps the line for the team it is quoted against", () => {
    const result = describeBet(
      bet({
        question: "Spread: Bills (-1.5)",
        outcomeLabel: "Bills",
        outcomes: ["Bills", "Texans"],
        outcomeIndex: 0,
        sportsMarketType: "spreads",
      }),
    );
    expect(result.action).toBe("Bet Bills -1.5");
    expect(result.winsIf).toBe("Bills win by more than 1.5.");
  });

  it("mirrors the line for the other team instead of reusing it", () => {
    // The trap: the question says -1.5 and it belongs to Bills. Texans are +1.5, and quoting them
    // at -1.5 would describe the opposite bet.
    const result = describeBet(
      bet({
        question: "Spread: Bills (-1.5)",
        outcomeLabel: "Texans",
        outcomes: ["Bills", "Texans"],
        outcomeIndex: 1,
        sportsMarketType: "spreads",
      }),
    );
    expect(result.action).toBe("Bet Texans +1.5");
    expect(result.winsIf).toBe("Texans win outright, or lose by less than 1.5.");
  });
});

describe("parsers", () => {
  it("reads the line out of the formats Polymarket uses", () => {
    expect(extractLine("Bills vs. Texans: O/U 41.5")).toBe(41.5);
    expect(extractLine("Bills vs. Texans: 1Q O/U 1.5")).toBe(1.5);
    expect(extractLine("Spread: Bills (-1.5)")).toBe(-1.5);
    expect(extractLine("1Q Spread: Texans (-0.5)")).toBe(-0.5);
  });

  it("returns null rather than a wrong number", () => {
    expect(extractLine("Bills vs. Texans")).toBeNull();
    expect(extractLine("Bills vs. Texans: Safety?")).toBeNull();
  });

  it("reads the team a spread is quoted against", () => {
    expect(extractSpreadTeam("Spread: Bills (-1.5)")).toBe("Bills");
    expect(extractSpreadTeam("2H Spread: Liverpool FC (-0.5)")).toBe("2H Spread: Liverpool FC".replace("2H Spread: ", ""));
    expect(extractSpreadTeam("Bills vs. Texans")).toBeNull();
  });

  it("produces a statement and both future forms from one pass", () => {
    const p = propositionFromQuestion("Will Rodri win the 2026 Ballon d'Or?");
    expect(p?.statement).toBe("Rodri wins the 2026 Ballon d'Or");
    expect(p?.willHappen).toBe("Rodri will win the 2026 Ballon d'Or");
    expect(p?.willNotHappen).toBe("Rodri will NOT win the 2026 Ballon d'Or");
  });

  it("puts `will` back in front of the verb, not at the front of the clause", () => {
    // The question is already inverted, so the declarative needs `will` moved back to the verb.
    const p = propositionFromQuestion("Will there be a recession?");
    expect(p?.statement).toBe("there is a recession");
    expect(p?.willHappen).toBe("there will be a recession");
  });

  it("negates with do-support, except for `be` which takes none", () => {
    expect(propositionFromQuestion("Will Liverpool FC win on 2026-09-12?")?.negatedStatement).toBe(
      "Liverpool FC does not win on 2026-09-12",
    );
    // "there does not be a recession" would be ungrammatical.
    expect(propositionFromQuestion("Will there be a recession?")?.negatedStatement).toBe(
      "there is not a recession",
    );
  });

  it("returns null when the question is not a 'Will ...?' form", () => {
    expect(propositionFromQuestion("Not a question")).toBeNull();
  });

  it("refuses to place `will` when the verb is unrecognised, rather than guessing wrong", () => {
    const p = propositionFromQuestion("Will Arsenal defenestrate Chelsea?");
    expect(p?.statement).toBe("Arsenal defenestrate Chelsea");
    expect(p?.willNotHappen).toBe("NOT: Arsenal defenestrate Chelsea");
  });
});

describe("stakeOutcome", () => {
  it("computes shares and profit from the price actually paid", () => {
    const result = stakeOutcome(1, 0.4);
    expect(result?.shares).toBeCloseTo(2.5, 10);
    expect(result?.returned).toBeCloseTo(2.5, 10);
    expect(result?.profit).toBeCloseTo(1.5, 10);
    expect(result?.lost).toBe(1);
  });

  it("uses the effective price, not the mid, so the spread is already paid for", () => {
    const atMid = stakeOutcome(1, 0.5);
    const atAsk = stakeOutcome(1, 0.52);
    expect((atAsk as { profit: number }).profit).toBeLessThan((atMid as { profit: number }).profit);
  });

  it("refuses prices that are not tradeable instead of returning Infinity", () => {
    expect(stakeOutcome(1, 0)).toBeNull();
    expect(stakeOutcome(1, 1)).toBeNull();
    expect(stakeOutcome(1, null)).toBeNull();
    expect(stakeOutcome(0, 0.5)).toBeNull();
    expect(stakeOutcome(-1, 0.5)).toBeNull();
  });
});
