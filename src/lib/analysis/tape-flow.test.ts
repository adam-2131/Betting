import { describe, expect, it } from "vitest";
import { analyzeTape, significantWindow, type TapeTrade } from "./tape-flow";

const NOW = new Date("2026-09-11T12:00:00Z");

function minutesAgo(minutes: number): number {
  return Math.floor(NOW.getTime() / 1000) - minutes * 60;
}

function trade(
  outcomeIndex: number,
  size: number,
  price: number,
  minutes: number,
): TapeTrade {
  return { outcomeIndex, size, price, timestamp: minutesAgo(minutes) };
}

describe("analyzeTape", () => {
  it("reads direction from the outcome, not the side", () => {
    // Every row on a live market came back as side BUY, because selling one outcome IS buying the
    // other and Polymarket normalises to the buy. Pressure is outcome A dollars against outcome B.
    const trades = [
      trade(0, 1000, 0.58, 10),
      trade(1, 100, 0.42, 20),
    ];
    const flow = analyzeTape(trades, 0, NOW);
    const hour = flow.windows[0];

    expect(hour.forUsd).toBeCloseTo(580, 6);
    expect(hour.againstUsd).toBeCloseTo(42, 6);
    expect(hour.netUsd).toBeCloseTo(538, 6);
    expect(hour.forShare).toBeCloseTo(580 / 622, 6);
  });

  it("separates the last hour from the day, so a shift is visible", () => {
    const trades = [
      // Yesterday's money was against.
      trade(1, 10_000, 0.5, 60 * 20),
      // The last hour has turned.
      trade(0, 5_000, 0.55, 30),
    ];
    const flow = analyzeTape(trades, 0, NOW);
    const [hour, , day] = flow.windows;

    expect(hour.netUsd).toBeGreaterThan(0);
    expect(day.netUsd).toBeLessThan(0);
  });

  it("measures whether recent takers paid up relative to the period", () => {
    const trades = [
      trade(0, 1000, 0.5, 60 * 12),
      trade(0, 1000, 0.5, 60 * 8),
      trade(0, 1000, 0.6, 20),
    ];
    const flow = analyzeTape(trades, 0, NOW);
    // The last hour averaged 60c against a day average nearer 53c.
    expect(flow.pricePressurePoints as number).toBeGreaterThan(5);
  });

  it("flags a tape too quiet to read", () => {
    expect(analyzeTape([trade(0, 10, 0.5, 5)], 0, NOW).tooQuiet).toBe(true);
    const busy = Array.from({ length: 8 }, (_, i) => trade(0, 100, 0.5, i));
    expect(analyzeTape(busy, 0, NOW).tooQuiet).toBe(false);
  });

  it("reports the largest single fill on this side", () => {
    const trades = [
      trade(0, 100, 0.5, 5),
      trade(0, 4000, 0.5, 10),
      trade(1, 9000, 0.5, 10),
    ];
    // The 9000 is on the other side and must not be reported as this side's biggest print.
    expect(analyzeTape(trades, 0, NOW).largestForUsd).toBeCloseTo(2000, 6);
  });

  it("excludes trades outside the window rather than scaling them", () => {
    const flow = analyzeTape([trade(0, 1000, 0.5, 60 * 5)], 0, NOW);
    expect(flow.windows[0].tradeCount).toBe(0);
    expect(flow.windows[0].forUsd).toBe(0);
    expect(flow.windows[1].tradeCount).toBe(1);
  });

  it("reports nulls rather than zeros when nothing traded", () => {
    const flow = analyzeTape([], 0, NOW);
    expect(flow.windows[0].forShare).toBeNull();
    expect(flow.windows[0].averagePrice).toBeNull();
    expect(flow.largestForUsd).toBeNull();
    expect(flow.tooQuiet).toBe(true);
  });

  it("ignores malformed rows instead of counting them as zero-dollar trades", () => {
    const trades: TapeTrade[] = [
      { outcomeIndex: 0, size: null, price: 0.5, timestamp: minutesAgo(5) },
      { outcomeIndex: 0, size: 100, price: null, timestamp: minutesAgo(5) },
      { outcomeIndex: 0, size: 100, price: 0.5, timestamp: null },
      trade(0, 100, 0.5, 5),
    ];
    expect(analyzeTape(trades, 0, NOW).windows[0].tradeCount).toBe(1);
  });
});

describe("significantWindow — what may be called a direction", () => {
  it("rejects a single tiny fill that is trivially 100% of one side", () => {
    // Verbatim from a live market: one $1 fill in the last hour, which the panel was reporting as
    // "money is going your way (100% of it)".
    const flow = analyzeTape([trade(0, 2, 0.5, 10)], 0, NOW);
    expect(flow.windows[0].forShare).toBe(1);
    expect(significantWindow(flow)).toBeNull();
  });

  it("rejects a window that clears the fill count but not the dollars", () => {
    // Three fills totalling $65 is not money moving.
    const trades = [trade(0, 44, 0.5, 5), trade(0, 44, 0.5, 6), trade(0, 42, 0.5, 7)];
    expect(significantWindow(analyzeTape(trades, 0, NOW))).toBeNull();
  });

  it("accepts a window with both real fills and real dollars", () => {
    const trades = Array.from({ length: 6 }, (_, i) => trade(0, 400, 0.5, i + 1));
    const window = significantWindow(analyzeTape(trades, 0, NOW));
    expect(window?.hours).toBe(1);
    expect(window?.forUsd).toBeCloseTo(1200, 6);
  });

  it("widens to the next window when the tightest is too thin", () => {
    const trades = [
      // One trivial fill this hour.
      trade(0, 2, 0.5, 10),
      // Real money earlier in the day.
      trade(1, 2000, 0.5, 60 * 4),
      trade(1, 2000, 0.5, 60 * 5),
      trade(1, 2000, 0.5, 60 * 5),
    ];
    const window = significantWindow(analyzeTape(trades, 0, NOW));
    expect(window?.hours).toBe(6);
    expect(window?.netUsd).toBeLessThan(0);
  });
});

describe("analyzeTape edge cases", () => {
  it("still counts only well-formed rows", () => {
    const trades: TapeTrade[] = [
      { outcomeIndex: 0, size: null, price: 0.5, timestamp: minutesAgo(5) },
      { outcomeIndex: 0, size: 100, price: null, timestamp: minutesAgo(5) },
      { outcomeIndex: 0, size: 100, price: 0.5, timestamp: null },
      trade(0, 100, 0.5, 5),
    ];
    expect(analyzeTape(trades, 0, NOW).windows[0].tradeCount).toBe(1);
  });
});
