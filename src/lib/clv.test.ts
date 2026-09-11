import { describe, expect, it } from "vitest";
import { clvPoints, describeClv, MIN_SAMPLE, summarizeClv, type ClvSample } from "./clv";

function samples(points: number[], entry = 0.5): ClvSample[] {
  // Build closing prices that produce exactly the requested CLV in points.
  return points.map((p) => ({ entryPrice: entry, closingPrice: entry + p / 100 }));
}

describe("clvPoints", () => {
  it("is positive when you bought below where the market finished", () => {
    expect(clvPoints(0.4, 0.45)).toBeCloseTo(5, 10);
  });

  it("is negative when you paid above the close", () => {
    expect(clvPoints(0.45, 0.4)).toBeCloseTo(-5, 10);
  });

  it("measures the decision, not the outcome", () => {
    // A bet that closed at 90c was well bought at 40c whether or not it went on to win. This is
    // the entire reason CLV is worth tracking separately from win rate.
    expect(clvPoints(0.4, 0.9)).toBeCloseTo(50, 10);
  });

  it("refuses prices that are not tradeable entries", () => {
    expect(clvPoints(0, 0.5)).toBeNull();
    expect(clvPoints(1, 0.5)).toBeNull();
    expect(clvPoints(null, 0.5)).toBeNull();
    expect(clvPoints(0.5, null)).toBeNull();
    expect(clvPoints(0.5, 1.4)).toBeNull();
  });

  it("allows a close of exactly 0 or 1, which is a settled market", () => {
    expect(clvPoints(0.4, 1)).toBeCloseTo(60, 10);
    expect(clvPoints(0.4, 0)).toBeCloseTo(-40, 10);
  });
});

describe("summarizeClv", () => {
  it("reports nothing but a count below the sample floor", () => {
    const summary = summarizeClv(samples([5, 5, 5]));
    expect(summary.count).toBe(3);
    expect(summary.meanPoints).toBeNull();
    expect(summary.verdict).toBe("TOO_FEW");
    // The hit rate needs no variance estimate, so it is still honest to show.
    expect(summary.positiveRate).toBe(1);
  });

  it("calls a consistent edge beating the close", () => {
    const summary = summarizeClv(samples([3, 4, 2, 5, 3, 4, 3, 4]));
    expect(summary.meanPoints as number).toBeGreaterThan(3);
    expect(summary.intervalLow as number).toBeGreaterThan(0);
    expect(summary.verdict).toBe("BEATING_THE_CLOSE");
  });

  it("calls a consistent deficit paying up", () => {
    const summary = summarizeClv(samples([-3, -4, -2, -5, -3, -4, -3, -4]));
    expect(summary.intervalHigh as number).toBeLessThan(0);
    expect(summary.verdict).toBe("PAYING_UP");
  });

  it("refuses to call a noisy sample either way", () => {
    // Same mean as the winning case, far more spread. The point of the interval.
    const summary = summarizeClv(samples([30, -25, 12, -18, 20, -14, 5, 8]));
    expect(summary.verdict).toBe("INCONCLUSIVE");
    expect(summary.intervalLow as number).toBeLessThan(0);
    expect(summary.intervalHigh as number).toBeGreaterThan(0);
  });

  it("does not let a large mean alone declare success", () => {
    // Five bets, huge average, huge spread — exactly the shape that fools people.
    const summary = summarizeClv(samples([40, -30, 35, -20, 25]));
    expect(summary.meanPoints as number).toBeGreaterThan(9);
    expect(summary.verdict).toBe("INCONCLUSIVE");
  });

  it("projects how many bets would settle an inconclusive result", () => {
    const summary = summarizeClv(samples([6, -2, 4, -1, 5, 0, 3, 1]));
    expect(summary.verdict).toBe("INCONCLUSIVE");
    expect(summary.betsNeeded as number).toBeGreaterThan(8);
  });

  it("withholds the projection when the effect is indistinguishable from zero", () => {
    const summary = summarizeClv(samples([5, -5, 5, -5, 5, -5]));
    expect(summary.meanPoints).toBeCloseTo(0, 10);
    expect(summary.betsNeeded).toBeNull();
  });

  it("reports the share of bets bought below the close", () => {
    const summary = summarizeClv(samples([1, 1, 1, -1, -1, -1, 1, 1]));
    expect(summary.positiveRate).toBeCloseTo(5 / 8, 10);
  });

  it("ignores samples whose prices are unusable rather than counting them as zero", () => {
    const mixed: ClvSample[] = [
      ...samples([4, 4, 4, 4, 4]),
      { entryPrice: 0, closingPrice: 0.5 },
      { entryPrice: 1, closingPrice: 0.5 },
    ];
    expect(summarizeClv(mixed).count).toBe(5);
  });

  it("handles an empty log without producing NaN", () => {
    const summary = summarizeClv([]);
    expect(summary.count).toBe(0);
    expect(summary.positiveRate).toBeNull();
    expect(summary.meanPoints).toBeNull();
    expect(summary.verdict).toBe("TOO_FEW");
  });
});

describe("describeClv", () => {
  it("says how many more are needed below the floor", () => {
    const text = describeClv(summarizeClv(samples([5, 5])));
    expect(text).toContain(`${MIN_SAMPLE - 2} more`);
  });

  it("invites the first entry when the log is empty", () => {
    expect(describeClv(summarizeClv([]))).toContain("No bet has reached its close");
  });

  it("does not call positive CLV profit", () => {
    const text = describeClv(summarizeClv(samples([3, 4, 2, 5, 3, 4, 3, 4])));
    expect(text).toContain("not profit");
  });

  it("says plainly to stop when the sample is negative", () => {
    const text = describeClv(summarizeClv(samples([-3, -4, -2, -5, -3, -4, -3, -4])));
    expect(text).toContain("stop");
  });

  it("names the remaining sample when inconclusive", () => {
    const text = describeClv(summarizeClv(samples([6, -2, 4, -1, 5, 0, 3, 1])));
    expect(text).toMatch(/about \d+ bets in total/);
  });
});
