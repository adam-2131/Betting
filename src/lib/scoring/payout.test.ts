import { describe, expect, it } from "vitest";
import {
  bankrollExposure,
  calculateExpectedValue,
  calculatePayout,
  isTradeablePrice,
  payoutPerDollar,
  quickStakes,
} from "./payout";

describe("calculatePayout — the worked example from the spec", () => {
  it("price = 0.25, stake = $1 gives 4 shares, $4 payout, $3 profit, $1 loss", () => {
    const result = calculatePayout(1, 0.25);
    expect(result.shares).toBe(4);
    expect(result.grossPayout).toBe(4);
    expect(result.profit).toBe(3);
    expect(result.lossIfWrong).toBe(1);
    expect(result.returnPct).toBe(3);
    expect(result.breakEvenProbability).toBe(0.25);
    expect(result.invalid).toBe(false);
  });

  it("price = 0.32, stake = $1 gives 3.125 shares and $2.13 profit", () => {
    const result = calculatePayout(1, 0.32);
    expect(result.shares).toBeCloseTo(3.125, 10);
    expect(result.grossPayout).toBeCloseTo(3.125, 10);
    expect(result.profit).toBeCloseTo(2.125, 10);
  });
});

describe("calculatePayout — boundary prices", () => {
  it("handles 1¢", () => {
    const result = calculatePayout(1, 0.01);
    expect(result.shares).toBeCloseTo(100, 10);
    expect(result.profit).toBeCloseTo(99, 10);
    expect(result.invalid).toBe(false);
  });

  it("handles 50¢", () => {
    const result = calculatePayout(1, 0.5);
    expect(result.shares).toBe(2);
    expect(result.profit).toBe(1);
    expect(result.returnPct).toBe(1);
  });

  it("handles 99¢", () => {
    const result = calculatePayout(1, 0.99);
    expect(result.shares).toBeCloseTo(1.0101, 3);
    expect(result.profit).toBeCloseTo(0.0101, 3);
    expect(result.returnPct).toBeCloseTo(0.0101, 3);
  });

  it("rejects a price of 0 rather than emitting Infinity shares", () => {
    const result = calculatePayout(1, 0);
    expect(result.invalid).toBe(true);
    expect(result.shares).toBeNull();
    expect(result.grossPayout).toBeNull();
    expect(result.invalidReason).toMatch(/above 0/i);
  });

  it("rejects a price of 1", () => {
    const result = calculatePayout(1, 1);
    expect(result.invalid).toBe(true);
    expect(result.shares).toBeNull();
  });

  it("rejects prices above 1 and below 0", () => {
    expect(calculatePayout(1, 1.5).invalid).toBe(true);
    expect(calculatePayout(1, -0.2).invalid).toBe(true);
  });
});

describe("calculatePayout — boundary stakes", () => {
  it("a $0 stake buys nothing but is not an error", () => {
    const result = calculatePayout(0, 0.25);
    expect(result.invalid).toBe(false);
    expect(result.shares).toBe(0);
    expect(result.grossPayout).toBe(0);
    expect(result.profit).toBe(0);
    expect(result.lossIfWrong).toBe(0);
    expect(result.returnPct).toBeNull();
    expect(result.breakEvenProbability).toBe(0.25);
  });

  it("rejects a negative stake", () => {
    expect(calculatePayout(-5, 0.25).invalid).toBe(true);
  });

  it("handles an extremely large stake without overflowing", () => {
    const result = calculatePayout(1_000_000_000, 0.5);
    expect(result.shares).toBe(2_000_000_000);
    expect(Number.isFinite(result.profit as number)).toBe(true);
  });

  it("handles a sub-cent stake", () => {
    const result = calculatePayout(0.01, 0.5);
    expect(result.shares).toBeCloseTo(0.02, 10);
    expect(result.profit).toBeCloseTo(0.01, 10);
  });
});

describe("calculatePayout — missing and malformed data", () => {
  it("returns invalid when the price is missing", () => {
    for (const price of [null, undefined, "", NaN, Infinity, "abc"]) {
      const result = calculatePayout(1, price);
      expect(result.invalid, `price=${String(price)}`).toBe(true);
      expect(result.shares).toBeNull();
    }
  });

  it("returns invalid when the stake is missing", () => {
    for (const stake of [null, undefined, NaN, Infinity, "abc"]) {
      expect(calculatePayout(stake, 0.5).invalid, `stake=${String(stake)}`).toBe(true);
    }
  });

  it("never produces NaN or Infinity in any output field", () => {
    const inputs: Array<[unknown, unknown]> = [
      [1, 0], [0, 0], [NaN, NaN], [Infinity, Infinity], [-1, -1],
      [null, null], [1, 1], [1e308, 1e-308], ["1", "0.5"],
    ];
    for (const [stake, price] of inputs) {
      const result = calculatePayout(stake, price);
      for (const [key, value] of Object.entries(result)) {
        if (typeof value === "number") {
          expect(Number.isFinite(value), `${key} for stake=${String(stake)} price=${String(price)}`).toBe(true);
        }
      }
    }
  });

  it("coerces numeric strings", () => {
    const result = calculatePayout("1", "0.25");
    expect(result.shares).toBe(4);
  });
});

describe("payoutPerDollar", () => {
  it("is the $1 case", () => {
    expect(payoutPerDollar(0.25).shares).toBe(4);
    expect(payoutPerDollar(0.25).stake).toBe(1);
  });
});

describe("isTradeablePrice", () => {
  it("accepts prices strictly between 0 and 1", () => {
    expect(isTradeablePrice(0.5)).toBe(true);
    expect(isTradeablePrice(0.001)).toBe(true);
  });
  it("rejects the endpoints and non-numbers", () => {
    expect(isTradeablePrice(0)).toBe(false);
    expect(isTradeablePrice(1)).toBe(false);
    expect(isTradeablePrice(null)).toBe(false);
    expect(isTradeablePrice(NaN)).toBe(false);
  });
});

describe("calculateExpectedValue — the worked example from the spec", () => {
  it("52% model estimate against a 42¢ price gives +$0.10 EV and 23.8% return on capital", () => {
    const result = calculateExpectedValue(0.52, 0.42);
    expect(result.evPerShare).toBeCloseTo(0.1, 10);
    expect(result.edgePoints).toBeCloseTo(10, 8);
    expect(result.returnOnCapital).toBeCloseTo(0.238, 3);
  });

  it("is negative when the model is below the market", () => {
    const result = calculateExpectedValue(0.3, 0.45);
    expect(result.evPerShare).toBeCloseTo(-0.15, 10);
    expect(result.returnOnCapital).toBeLessThan(0);
  });

  it("is zero at the market price", () => {
    expect(calculateExpectedValue(0.42, 0.42).evPerShare).toBeCloseTo(0, 10);
  });

  it("returns nulls rather than NaN for unusable inputs", () => {
    for (const [p, price] of [[null, 0.5], [0.5, 0], [0.5, 1], [1.5, 0.5], [-0.1, 0.5], [0.5, null]]) {
      const result = calculateExpectedValue(p, price);
      expect(result.evPerShare, `p=${String(p)} price=${String(price)}`).toBeNull();
      expect(result.returnOnCapital).toBeNull();
    }
  });
});

describe("bankrollExposure — small bankroll mode", () => {
  it("reproduces the spec's $7 bankroll table", () => {
    expect(bankrollExposure(0.25, 7).fractionOfBankroll).toBeCloseTo(0.0357, 4);
    expect(bankrollExposure(0.5, 7).fractionOfBankroll).toBeCloseTo(0.0714, 4);
    expect(bankrollExposure(1, 7).fractionOfBankroll).toBeCloseTo(0.1429, 4);
    expect(bankrollExposure(2, 7).fractionOfBankroll).toBeCloseTo(0.2857, 4);
  });

  it("escalates severity as the stake grows", () => {
    expect(bankrollExposure(0.25, 7).severity).toBe("low");
    expect(bankrollExposure(1, 7).severity).toBe("moderate");
    expect(bankrollExposure(2, 7).severity).toBe("high");
    expect(bankrollExposure(7, 7).severity).toBe("extreme");
  });

  it("does not divide by a zero or missing bankroll", () => {
    expect(bankrollExposure(1, 0).fractionOfBankroll).toBeNull();
    expect(bankrollExposure(1, null).fractionOfBankroll).toBeNull();
    expect(bankrollExposure(1, -5).fractionOfBankroll).toBeNull();
  });
});

describe("quickStakes", () => {
  it("includes ALL only when a bankroll is set, and ALL is just an amount", () => {
    const withBankroll = quickStakes(7);
    expect(withBankroll.map((s) => s.label)).toEqual(["$0.25", "$0.50", "$1", "$2", "ALL"]);
    expect(withBankroll.at(-1)?.amount).toBe(7);

    expect(quickStakes(null).map((s) => s.label)).toEqual(["$0.25", "$0.50", "$1", "$2"]);
    expect(quickStakes(0).map((s) => s.label)).not.toContain("ALL");
  });
});
