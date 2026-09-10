import { describe, expect, it } from "vitest";
import {
  UNAVAILABLE,
  clampScore,
  formatCents,
  formatPercent,
  formatSignedCents,
  formatSignedUsd,
  formatUsd,
  herfindahl,
  mean,
  median,
  safeDivide,
  safeNumber,
  scaleToScore,
  stdDev,
  sum,
  weightedMean,
} from "./num";

describe("safeNumber", () => {
  it("passes finite numbers through", () => {
    expect(safeNumber(42)).toBe(42);
    expect(safeNumber(0)).toBe(0);
    expect(safeNumber(-1.5)).toBe(-1.5);
  });

  it("converts NaN and Infinity to null — these must never reach the UI", () => {
    expect(safeNumber(NaN)).toBeNull();
    expect(safeNumber(Infinity)).toBeNull();
    expect(safeNumber(-Infinity)).toBeNull();
  });

  it("treats null, undefined and empty string as unknown", () => {
    expect(safeNumber(null)).toBeNull();
    expect(safeNumber(undefined)).toBeNull();
    expect(safeNumber("")).toBeNull();
  });

  it("coerces numeric strings, which the Polymarket API returns for several fields", () => {
    expect(safeNumber("0.25")).toBe(0.25);
    expect(safeNumber("1366287.25604")).toBeCloseTo(1366287.25604, 5);
    expect(safeNumber("not a number")).toBeNull();
  });
});

describe("safeDivide", () => {
  it("divides normally", () => {
    expect(safeDivide(10, 4)).toBe(2.5);
  });

  it("returns null on a zero denominator instead of Infinity", () => {
    expect(safeDivide(1, 0)).toBeNull();
    expect(safeDivide(0, 0)).toBeNull();
  });

  it("returns null when either side is unknown", () => {
    expect(safeDivide(null, 5)).toBeNull();
    expect(safeDivide(5, null)).toBeNull();
    expect(safeDivide(NaN, 5)).toBeNull();
  });
});

describe("aggregates", () => {
  it("sum ignores nulls", () => {
    expect(sum([1, null, 2, undefined, 3])).toBe(6);
    expect(sum([])).toBe(0);
  });

  it("mean returns null for an empty set", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([])).toBeNull();
    expect(mean([null, undefined])).toBeNull();
  });

  it("median handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("stdDev needs at least two samples", () => {
    expect(stdDev([5])).toBeNull();
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });

  it("weightedMean ignores non-positive weights", () => {
    expect(weightedMean([{ value: 1, weight: 1 }, { value: 3, weight: 3 }])).toBe(2.5);
    expect(weightedMean([{ value: 1, weight: 0 }])).toBeNull();
    expect(weightedMean([])).toBeNull();
  });
});

describe("herfindahl", () => {
  it("is 1 for a single holding", () => {
    expect(herfindahl([100])).toBe(1);
  });

  it("approaches 1/n for evenly spread holdings", () => {
    expect(herfindahl([25, 25, 25, 25])).toBeCloseTo(0.25, 10);
  });

  it("returns null for an empty or zero-total set rather than dividing by zero", () => {
    expect(herfindahl([])).toBeNull();
    expect(herfindahl([0, 0])).toBeNull();
    expect(herfindahl([null, undefined])).toBeNull();
  });
});

describe("scaleToScore", () => {
  it("maps a range onto 0-100 and clamps outside it", () => {
    expect(scaleToScore(0.5, 0, 1)).toBe(50);
    expect(scaleToScore(-5, 0, 1)).toBe(0);
    expect(scaleToScore(5, 0, 1)).toBe(100);
  });

  it("does not divide by zero when min equals max", () => {
    expect(scaleToScore(1, 1, 1)).toBe(50);
  });

  it("returns null for unknown input", () => {
    expect(scaleToScore(null, 0, 1)).toBeNull();
  });
});

describe("clampScore", () => {
  it("clamps into 0-100 and never yields NaN", () => {
    expect(clampScore(150)).toBe(100);
    expect(clampScore(-20)).toBe(0);
    expect(clampScore(NaN)).toBe(0);
    expect(clampScore(null)).toBe(0);
    expect(clampScore(84.44)).toBe(84.4);
  });
});

describe("formatters render Unavailable rather than fabricating a value", () => {
  it("covers every formatter", () => {
    expect(formatUsd(null)).toBe(UNAVAILABLE);
    expect(formatSignedUsd(null)).toBe(UNAVAILABLE);
    expect(formatCents(null)).toBe(UNAVAILABLE);
    expect(formatSignedCents(null)).toBe(UNAVAILABLE);
    expect(formatPercent(null)).toBe(UNAVAILABLE);
    expect(formatUsd(NaN)).toBe(UNAVAILABLE);
    expect(formatCents(Infinity)).toBe(UNAVAILABLE);
  });

  it("formats money compactly", () => {
    expect(formatUsd(1_400_000)).toBe("$1.40M");
    expect(formatUsd(14_200)).toBe("$14.2k");
    expect(formatUsd(1234)).toBe("$1,234");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(-412_000)).toBe("-$412.0k");
  });

  it("formats prices as cents the way Polymarket displays them", () => {
    expect(formatCents(0.32)).toBe("32.0¢");
    expect(formatCents(0.32, 0)).toBe("32¢");
    expect(formatSignedCents(0.03)).toBe("+3.0¢");
    expect(formatSignedCents(-0.037)).toBe("-3.7¢");
  });

  it("keeps the sign on PnL", () => {
    expect(formatSignedUsd(1000)).toBe("+$1,000");
    expect(formatSignedUsd(-1000)).toBe("-$1,000");
  });
});
