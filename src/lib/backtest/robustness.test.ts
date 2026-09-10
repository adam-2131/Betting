import { describe, expect, it } from "vitest";
import { summarizeRobustness, type HorizonOutcome } from "./robustness";

function horizon(overrides: Partial<HorizonOutcome> = {}): HorizonOutcome {
  return {
    horizonDays: 1,
    signals: 500,
    winRate: 0.52,
    impliedWinRate: 0.515,
    edgePoints: 0.5,
    rankCorrelation: -0.05,
    bestBandLabel: "20–40",
    bestBandEdgePoints: 3,
    bestBandPValue: 0.4,
    overallEdgePValue: 0.5,
    significantAlone: false,
    ...overrides,
  };
}

describe("summarizeRobustness", () => {
  it("calls a clean negative result what it is", () => {
    const report = summarizeRobustness([
      horizon({ horizonDays: 1 }),
      horizon({ horizonDays: 2 }),
      horizon({ horizonDays: 3 }),
    ]);

    expect(report.verdict).toBe("NOTHING FOUND");
    expect(report.narrative[0]).toContain("clean negative result");
  });

  it("refuses to call a one-horizon hit an edge", () => {
    // This is the real case: significant at 1d, nowhere else.
    const report = summarizeRobustness([
      horizon({ horizonDays: 1, bestBandPValue: 0.009, significantAlone: true }),
      horizon({ horizonDays: 2, bestBandPValue: 0.128 }),
      horizon({ horizonDays: 3, bestBandPValue: 0.641 }),
      horizon({ horizonDays: 5, bestBandPValue: 0.126 }),
    ]);

    expect(report.verdict).toBe("DOES NOT REPLICATE");
    expect(report.replicatedBands).toHaveLength(0);
    expect(report.narrative.join(" ")).toContain("not evidence of an edge");
  });

  it("does not credit two hits in different bands as replication", () => {
    // Different bands winning at different horizons is noise moving around, not one effect.
    const report = summarizeRobustness([
      horizon({ horizonDays: 1, bestBandLabel: "20–40", bestBandPValue: 0.01, significantAlone: true }),
      horizon({ horizonDays: 7, bestBandLabel: "70–85", bestBandPValue: 0.02, significantAlone: true }),
      horizon({ horizonDays: 2 }),
    ]);

    expect(report.verdict).toBe("DOES NOT REPLICATE");
    expect(report.replicatedBands).toHaveLength(0);
    expect(report.significantHorizons).toEqual([1, 7]);
  });

  it("credits a band that holds across most horizons", () => {
    const report = summarizeRobustness([
      horizon({ horizonDays: 1, bestBandLabel: "70–85", bestBandPValue: 0.01, significantAlone: true }),
      horizon({ horizonDays: 2, bestBandLabel: "70–85", bestBandPValue: 0.03, significantAlone: true }),
      horizon({ horizonDays: 3 }),
    ]);

    expect(report.verdict).toBe("REPLICATES");
    expect(report.replicatedBands).toEqual([
      { label: "70–85", horizons: [1, 2], clearedIn: 2, usable: 3 },
    ]);
    // Even a replicated result must not be sold as settled, nor as independent evidence.
    const text = report.narrative.join(" ");
    expect(text).toContain("not a settled conclusion");
    expect(text).toContain("not independent experiments");
  });

  it("calls two hits out of five inconsistent, not replication", () => {
    // The actual observed pattern: significant at 1d and 7d, failing at 2d, 3d and 5d in between.
    // Treating "the same band twice" as replication would have overstated this.
    const report = summarizeRobustness([
      horizon({ horizonDays: 1, signals: 1076, bestBandPValue: 0.006, significantAlone: true }),
      horizon({ horizonDays: 2, signals: 920, bestBandPValue: 0.135 }),
      horizon({ horizonDays: 3, signals: 835, bestBandPValue: 0.671 }),
      horizon({ horizonDays: 5, signals: 678, bestBandPValue: 0.129 }),
      horizon({ horizonDays: 7, signals: 154, bestBandPValue: 0.019, significantAlone: true }),
    ]);

    expect(report.verdict).toBe("INCONSISTENT");
    expect(report.replicatedBands[0]).toMatchObject({ clearedIn: 2, usable: 5 });
    const text = report.narrative.join(" ");
    expect(text).toContain("not replication");
    expect(text).toContain("unresolved lead");
  });

  it("will not draw a conclusion from thin horizons", () => {
    const report = summarizeRobustness([
      horizon({ horizonDays: 7, signals: 40, bestBandPValue: 0.02, significantAlone: false }),
      horizon({ horizonDays: 14, signals: 12 }),
    ]);

    expect(report.verdict).toBe("TOO LITTLE DATA");
    expect(report.usableHorizons).toBe(0);
  });

  it("reports when the score orders signals backwards at every horizon", () => {
    const report = summarizeRobustness([
      horizon({ horizonDays: 1, rankCorrelation: -0.1 }),
      horizon({ horizonDays: 2, rankCorrelation: -0.08 }),
      horizon({ horizonDays: 3, rankCorrelation: -0.02 }),
    ]);

    expect(report.narrative.join(" ")).toContain("slightly backwards");
  });

  it("softens the wording when some horizons rank positively", () => {
    const report = summarizeRobustness([
      horizon({ horizonDays: 1, rankCorrelation: 0.1 }),
      horizon({ horizonDays: 2, rankCorrelation: -0.08 }),
    ]);

    const text = report.narrative.join(" ");
    expect(text).toContain("not consistently informative");
    expect(text).not.toContain("slightly backwards");
  });

  it("says nothing about ranking when no horizon could measure it", () => {
    const report = summarizeRobustness([
      horizon({ horizonDays: 1, rankCorrelation: null }),
      horizon({ horizonDays: 2, rankCorrelation: null }),
    ]);

    expect(report.narrative.join(" ")).not.toContain("rank correlation");
  });

  it("handles an empty sweep without throwing", () => {
    const report = summarizeRobustness([]);
    expect(report.verdict).toBe("TOO LITTLE DATA");
    expect(report.horizons).toHaveLength(0);
    expect(report.narrative.length).toBeGreaterThan(0);
  });

  it("never uses hype language in any verdict", () => {
    const reports = [
      summarizeRobustness([horizon(), horizon({ horizonDays: 2 })]),
      summarizeRobustness([
        horizon({ bestBandPValue: 0.001, significantAlone: true }),
        horizon({ horizonDays: 2, bestBandPValue: 0.001, significantAlone: true }),
      ]),
    ];

    for (const report of reports) {
      const text = report.narrative.join(" ").toLowerCase();
      for (const word of ["guaranteed", "easy money", "sure bet", "can't lose", "proven edge"]) {
        expect(text).not.toContain(word);
      }
    }
  });
});
