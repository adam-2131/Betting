import { describe, expect, it } from "vitest";
import {
  calibrationTest,
  seededRandom,
  significanceLabel,
  wilsonInterval,
  type CalibrationObservation,
} from "./stats";

describe("wilsonInterval", () => {
  it("brackets the observed rate", () => {
    const interval = wilsonInterval(60, 100);
    expect(interval).not.toBeNull();
    expect(interval!.low).toBeLessThan(0.6);
    expect(interval!.high).toBeGreaterThan(0.6);
  });

  it("narrows as the sample grows", () => {
    const small = wilsonInterval(30, 50)!;
    const large = wilsonInterval(600, 1000)!;
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it("stays inside [0,1] at the extremes, where the normal approximation would not", () => {
    // 0/10 under the normal approximation gives a negative lower bound.
    const none = wilsonInterval(0, 10)!;
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0);
    expect(none.high).toBeLessThan(1);

    const all = wilsonInterval(10, 10)!;
    expect(all.high).toBeLessThanOrEqual(1);
    expect(all.high).toBeCloseTo(1, 10);
    expect(all.low).toBeLessThan(1);
    expect(all.low).toBeGreaterThan(0);
  });

  it("matches the textbook interval for 1 success in 10", () => {
    const interval = wilsonInterval(1, 10)!;
    expect(interval.low).toBeCloseTo(0.0179, 3);
    expect(interval.high).toBeCloseTo(0.4041, 3);
  });

  it("is honest about the 8-signal bucket the backtest actually produced", () => {
    // 3 of 8 wins. The point estimate reads a committal 37.5%; the real range spans more than
    // half the probability line, which is the whole reason this function exists.
    const interval = wilsonInterval(3, 8)!;
    expect(interval.high - interval.low).toBeGreaterThan(0.5);
    expect(interval.low).toBeLessThan(0.15);
    expect(interval.high).toBeGreaterThan(0.65);
  });

  it("returns null rather than NaN for impossible inputs", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(5, 3)).toBeNull();
    expect(wilsonInterval(-1, 10)).toBeNull();
    expect(wilsonInterval(Number.NaN, 10)).toBeNull();
    expect(wilsonInterval(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("seededRandom", () => {
  it("is deterministic for a given seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const first = Array.from({ length: 20 }, () => a());
    const second = Array.from({ length: 20 }, () => b());
    expect(first).toEqual(second);
  });

  it("differs across seeds", () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it("stays inside [0,1)", () => {
    const random = seededRandom(7);
    for (let i = 0; i < 5000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("has roughly the right mean over many draws", () => {
    const random = seededRandom(99);
    let total = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) total += random();
    expect(total / n).toBeCloseTo(0.5, 2);
  });
});

describe("calibrationTest", () => {
  const BUCKETS = 6;

  function observation(overrides: Partial<CalibrationObservation> = {}): CalibrationObservation {
    return { bucket: 2, impliedProbability: 0.5, score: 50, won: true, ...overrides };
  }

  /** Outcomes drawn from the price itself: a perfectly calibrated, information-free dataset. */
  function calibratedSet(n: number, seed: number): CalibrationObservation[] {
    const random = seededRandom(seed);
    return Array.from({ length: n }, (_, i) => {
      const price = 0.2 + ((i * 7) % 60) / 100;
      const score = (i * 13) % 100;
      return {
        bucket: Math.min(BUCKETS - 1, Math.floor(score / (100 / BUCKETS))),
        impliedProbability: price,
        score,
        won: random() < price,
      };
    });
  }

  it("finds no significance in a perfectly calibrated dataset", () => {
    // The market price IS the truth here, so nothing may look like an edge.
    const result = calibrationTest(calibratedSet(600, 5), BUCKETS, {
      iterations: 400,
      seed: 11,
    });

    expect(result.overallEdgePValue!).toBeGreaterThan(0.05);
    expect(result.bestBucketEdgePValue!).toBeGreaterThan(0.05);
  });

  it("detects a genuine edge planted in one bucket", () => {
    const base = calibratedSet(600, 5);
    const planted = base.map((o) => (o.bucket === 5 ? { ...o, won: true } : o));

    const result = calibrationTest(planted, BUCKETS, { iterations: 400, seed: 11 });

    expect(result.bestBucketIndex).toBe(5);
    expect(result.bestBucketEdgePoints!).toBeGreaterThan(20);
    expect(result.bestBucketEdgePValue!).toBeLessThan(0.01);
  });

  it("is not fooled by a bucket that only holds correctly-priced longshots", () => {
    // This is the trap a naive outcome-shuffle null falls into. Bucket 5 holds only 10c outcomes
    // winning 10% of the time — perfectly priced, no edge — but its win rate is nowhere near the
    // dataset average. Shuffling outcomes globally would manufacture a large edge here.
    const random = seededRandom(3);
    const observations: CalibrationObservation[] = [];
    for (let i = 0; i < 300; i++) {
      observations.push(
        observation({ bucket: 1, impliedProbability: 0.5, score: 25, won: random() < 0.5 }),
      );
    }
    for (let i = 0; i < 300; i++) {
      observations.push(
        observation({ bucket: 5, impliedProbability: 0.1, score: 90, won: random() < 0.1 }),
      );
    }

    const result = calibrationTest(observations, BUCKETS, { iterations: 400, seed: 11 });

    expect(result.bestBucketEdgePValue!).toBeGreaterThan(0.05);
  });

  it("ignores buckets below the minimum size when picking the best", () => {
    const base = calibratedSet(400, 5);
    // A four-signal bucket with a perfect record must not become the headline.
    const tiny = Array.from({ length: 4 }, () =>
      observation({ bucket: 0, impliedProbability: 0.2, score: 5, won: true }),
    );

    const result = calibrationTest([...base, ...tiny], BUCKETS, {
      iterations: 200,
      minBucketSize: 20,
      seed: 11,
    });

    expect(result.bestBucketIndex).not.toBe(0);
  });

  it("never reports a p-value of zero from a finite simulation", () => {
    // 200 winners at 5c is about as extreme as data gets; the null never reproduces it.
    const certain = Array.from({ length: 200 }, () =>
      observation({ bucket: 3, impliedProbability: 0.05, score: 60, won: true }),
    );

    const result = calibrationTest(certain, BUCKETS, { iterations: 100, seed: 11 });

    expect(result.bestBucketEdgePValue!).toBeGreaterThan(0);
    expect(result.bestBucketEdgePValue!).toBeCloseTo(1 / 101, 6);
  });

  it("is reproducible for a fixed seed", () => {
    const set = calibratedSet(200, 5);
    const a = calibrationTest(set, BUCKETS, { iterations: 200, seed: 77 });
    const b = calibrationTest(set, BUCKETS, { iterations: 200, seed: 77 });
    expect(a).toEqual(b);
  });

  it("returns empty results rather than NaN for too little data", () => {
    const result = calibrationTest([observation()], BUCKETS, { iterations: 50 });
    expect(result.iterations).toBe(0);
    expect(result.bestBucketEdgePValue).toBeNull();
    expect(result.rankCorrelationPValue).toBeNull();
    expect(result.overallEdgePValue).toBeNull();
  });

  it("discards observations whose price is not a usable probability", () => {
    const bad = [
      ...Array.from({ length: 40 }, () => observation({ impliedProbability: 0 })),
      ...Array.from({ length: 40 }, () => observation({ impliedProbability: 1 })),
      ...Array.from({ length: 40 }, () => observation({ impliedProbability: Number.NaN })),
    ];
    expect(calibrationTest(bad, BUCKETS, { iterations: 50 }).iterations).toBe(0);
  });

  it("keeps every reported p-value inside (0,1]", () => {
    const result = calibrationTest(calibratedSet(300, 8), BUCKETS, {
      iterations: 200,
      seed: 11,
    });
    for (const p of [
      result.bestBucketEdgePValue,
      result.rankCorrelationPValue,
      result.overallEdgePValue,
    ]) {
      expect(p).not.toBeNull();
      expect(p as number).toBeGreaterThan(0);
      expect(p as number).toBeLessThanOrEqual(1);
    }
  });
});

describe("significanceLabel", () => {
  it("never claims certainty", () => {
    for (const p of [null, 0, 0.001, 0.03, 0.1, 0.5, 1]) {
      const text = significanceLabel(p).text.toLowerCase();
      expect(text).not.toContain("guaranteed");
      expect(text).not.toContain("proven");
      expect(text).not.toContain("certain");
    }
  });

  it("grades from chance to unlikely-to-be-chance", () => {
    expect(significanceLabel(0.005).text).toBe("Unlikely to be chance");
    expect(significanceLabel(0.03).text).toBe("Possibly real");
    expect(significanceLabel(0.15).text).toBe("Consistent with chance");
    expect(significanceLabel(0.6).text).toBe("Indistinguishable from chance");
    expect(significanceLabel(null).text).toBe("Not testable");
  });
});
