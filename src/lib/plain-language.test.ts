import { describe, expect, it } from "vitest";
import {
  describeOpportunity,
  entryVerdict,
  WHAT_THIS_CANNOT_TELL_YOU,
  type PlainSummaryInput,
} from "./plain-language";

function input(overrides: Partial<PlainSummaryInput> = {}): PlainSummaryInput {
  return {
    outcomeLabel: "Yes",
    currentPrice: 0.41,
    trackedEntry: 0.38,
    entryGap: 0.03,
    qualifiedTraders: 4,
    opposingTraders: 0,
    bankroll: 7,
    ...overrides,
  };
}

describe("entryVerdict", () => {
  it("grades the bands", () => {
    expect(entryVerdict(-5)).toBe("BETTER_THAN_THEM");
    expect(entryVerdict(0)).toBe("SIMILAR_ENTRY");
    expect(entryVerdict(3)).toBe("SIMILAR_ENTRY");
    expect(entryVerdict(5)).toBe("PAYING_MORE");
    expect(entryVerdict(8)).toBe("PAYING_MORE");
    expect(entryVerdict(20)).toBe("LATE");
  });

  it("returns UNKNOWN rather than guessing when there is no gap", () => {
    expect(entryVerdict(null)).toBe("UNKNOWN");
    expect(entryVerdict(Number.NaN)).toBe("UNKNOWN");
    expect(entryVerdict(Number.POSITIVE_INFINITY)).toBe("UNKNOWN");
  });
});

describe("describeOpportunity", () => {
  it("says who is holding, on which side, at what price", () => {
    const summary = describeOpportunity(input());
    expect(summary.headline).toContain("4 tracked traders are holding");
    expect(summary.headline).toContain("YES");
    expect(summary.headline).toContain("41");
  });

  it("uses singular wording for one trader", () => {
    const summary = describeOpportunity(input({ qualifiedTraders: 1 }));
    expect(summary.headline).toContain("1 tracked trader is holding");
    expect(summary.headline).not.toContain("traders are");
  });

  it("mentions traders on the opposing side", () => {
    const summary = describeOpportunity(input({ opposingTraders: 2 }));
    expect(summary.headline).toContain("2 tracked traders are on the other side");
  });

  it("explains a good entry without overselling it", () => {
    const summary = describeOpportunity(input({ entryGap: 0.01 }));
    expect(summary.verdict).toBe("SIMILAR_ENTRY");
    expect(summary.entry).toContain("roughly what they did");
    expect(summary.entry.toLowerCase()).not.toContain("great");
    expect(summary.entry.toLowerCase()).not.toContain("opportunity");
  });

  it("is blunt when the move has already happened", () => {
    const summary = describeOpportunity(input({ currentPrice: 0.72, entryGap: 0.34 }));
    expect(summary.verdict).toBe("LATE");
    expect(summary.entry).toContain("already happened");
    expect(summary.entry).toContain("different trade");
  });

  it("says when the current price beats the tracked entry", () => {
    const summary = describeOpportunity(input({ currentPrice: 0.3, entryGap: -0.08 }));
    expect(summary.verdict).toBe("BETTER_THAN_THEM");
    expect(summary.entry).toContain("below their price");
    // The magnitude must read as a positive number of cents, never "-8¢ cheaper".
    expect(summary.entry).toContain("8¢ cheaper");
    expect(summary.entry).not.toContain("-8");
  });

  it("shows both sides of the stake, including losing it", () => {
    const summary = describeOpportunity(input({ currentPrice: 0.5, bankroll: 7 }));
    expect(summary.stake).toContain("$7");
    expect(summary.stake).toContain("14.0 shares");
    expect(summary.stake).toContain("you get nothing back");
  });

  it("never tells the reader how much to stake", () => {
    const summary = describeOpportunity(input());
    const all = `${summary.headline} ${summary.entry} ${summary.stake} ${summary.action}`.toLowerCase();
    for (const phrase of ["you should bet", "should stake", "we recommend", "recommended stake", "bet "]) {
      expect(all).not.toContain(phrase);
    }
    expect(summary.stake).toMatch(/would buy/);
  });

  it("never uses hype language in any band", () => {
    const cases = [-0.2, -0.02, 0.01, 0.05, 0.3].map((entryGap) =>
      describeOpportunity(input({ entryGap })),
    );
    for (const summary of cases) {
      const all = `${summary.headline} ${summary.entry} ${summary.stake} ${summary.action}`.toLowerCase();
      for (const word of ["guaranteed", "easy money", "sure bet", "can't lose", "free money", "no risk"]) {
        expect(all).not.toContain(word);
      }
    }
  });

  it("always states that the trade is placed manually", () => {
    const summary = describeOpportunity(input());
    expect(summary.action).toContain("yourself on Polymarket");
    expect(summary.action).toContain("never places");
  });

  it("omits the entry sentence rather than inventing one", () => {
    const summary = describeOpportunity(input({ trackedEntry: null, entryGap: null }));
    expect(summary.verdict).toBe("UNKNOWN");
    expect(summary.entry).toContain("no recorded entry price");
    expect(summary.entry).not.toContain("NaN");
    expect(summary.entry).not.toContain("null");
  });

  it("omits the stake sentence when no bankroll is set", () => {
    expect(describeOpportunity(input({ bankroll: undefined })).stake).toBe("");
  });

  it("omits the stake sentence when the price is unusable", () => {
    for (const currentPrice of [null, 0, 1, Number.NaN]) {
      expect(describeOpportunity(input({ currentPrice })).stake).toBe("");
    }
  });

  it("handles a side nobody qualified holds", () => {
    const summary = describeOpportunity(input({ qualifiedTraders: 0 }));
    expect(summary.headline).toContain("No qualified tracked trader");
    expect(summary.action).toBe("Nothing to follow here.");
  });

  it("never emits NaN, Infinity, undefined or null into prose", () => {
    const awkward: Array<Partial<PlainSummaryInput>> = [
      { currentPrice: Number.NaN, trackedEntry: Number.NaN, entryGap: Number.NaN },
      { currentPrice: Number.POSITIVE_INFINITY, entryGap: Number.POSITIVE_INFINITY },
      { currentPrice: null, trackedEntry: null, entryGap: null, bankroll: undefined },
      { outcomeLabel: "", qualifiedTraders: 0, opposingTraders: 0 },
      { bankroll: 0 },
      { bankroll: 1e12, currentPrice: 0.01 },
    ];

    for (const overrides of awkward) {
      const summary = describeOpportunity(input(overrides));
      const all = `${summary.headline} ${summary.entry} ${summary.stake} ${summary.action} ${summary.verdictLabel}`;
      expect(all).not.toContain("NaN");
      expect(all).not.toContain("Infinity");
      expect(all).not.toContain("undefined");
      expect(all).not.toContain("null");
    }
  });

  it("falls back to a readable phrase for a blank outcome label", () => {
    const summary = describeOpportunity(input({ outcomeLabel: "   " }));
    expect(summary.headline).toContain("THIS OUTCOME");
  });
});

describe("WHAT_THIS_CANNOT_TELL_YOU", () => {
  it("states the backtest result plainly and does not soften it", () => {
    expect(WHAT_THIS_CANNOT_TELL_YOU).toContain("has not been shown to predict");
    expect(WHAT_THIS_CANNOT_TELL_YOU).toContain("not as a reason to buy");
  });
});
