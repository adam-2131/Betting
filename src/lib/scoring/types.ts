/**
 * Shared shapes for the scoring layer.
 *
 * Every score in PolyAlpha returns not just a number but the components and penalties that
 * produced it, because the UI renders the full breakdown. A score with no visible derivation is
 * exactly what this product is trying not to be.
 */

export interface ScoreComponent {
  key: string;
  label: string;
  /** The component's own 0-100 sub-score. Null when the input was unavailable. */
  value: number | null;
  /** Percentage weight this component carries. */
  weight: number;
  /** Points this component contributed to the final score. */
  contribution: number;
  /** Short plain-language note on what drove the sub-score. */
  detail?: string;
}

export interface ScorePenalty {
  key: string;
  label: string;
  /** Always negative. */
  points: number;
  detail: string;
}

export interface ScoreResult {
  /** Final 0-100 score, after penalties, clamped. */
  score: number;
  /** Score before penalties, for display. */
  baseScore: number;
  components: ScoreComponent[];
  penalties: ScorePenalty[];
  /** Total penalty points applied (negative or zero). */
  penaltyTotal: number;
}

/**
 * Combines weighted components into a base score.
 *
 * Components whose value is null are excluded and their weight is redistributed across the
 * available components, so a missing input degrades confidence rather than silently scoring 0.
 * If nothing at all is available the score is 0 with every component marked unavailable.
 */
export function combineComponents(
  entries: Array<{ key: string; label: string; value: number | null; weight: number; detail?: string }>,
): { baseScore: number; components: ScoreComponent[] } {
  const available = entries.filter((e) => e.value !== null && Number.isFinite(e.value));
  const availableWeight = available.reduce((acc, e) => acc + e.weight, 0);

  if (availableWeight <= 0) {
    return {
      baseScore: 0,
      components: entries.map((e) => ({
        key: e.key,
        label: e.label,
        value: null,
        weight: e.weight,
        contribution: 0,
        detail: e.detail ?? "Unavailable",
      })),
    };
  }

  const components: ScoreComponent[] = entries.map((e) => {
    if (e.value === null || !Number.isFinite(e.value)) {
      return {
        key: e.key,
        label: e.label,
        value: null,
        weight: e.weight,
        contribution: 0,
        detail: e.detail ?? "Unavailable",
      };
    }
    // Redistribute the missing components' weight proportionally.
    const effectiveWeight = (e.weight / availableWeight) * 100;
    const clamped = Math.min(100, Math.max(0, e.value));
    return {
      key: e.key,
      label: e.label,
      value: Math.round(clamped * 10) / 10,
      weight: e.weight,
      contribution: Math.round(((clamped * effectiveWeight) / 100) * 10) / 10,
      detail: e.detail,
    };
  });

  const baseScore = components.reduce((acc, c) => acc + c.contribution, 0);
  return { baseScore: Math.round(Math.min(100, Math.max(0, baseScore)) * 10) / 10, components };
}

/** Applies penalties to a base score and clamps into 0-100. */
export function applyPenalties(
  baseScore: number,
  penalties: ScorePenalty[],
  components: ScoreComponent[],
): ScoreResult {
  const penaltyTotal = penalties.reduce((acc, p) => acc + p.points, 0);
  const score = Math.min(100, Math.max(0, baseScore + penaltyTotal));
  return {
    score: Math.round(score * 10) / 10,
    baseScore: Math.round(baseScore * 10) / 10,
    components,
    penalties,
    penaltyTotal: Math.round(penaltyTotal * 10) / 10,
  };
}

/** An empty, honest result for when there is genuinely nothing to score. */
export function emptyScore(reason: string): ScoreResult {
  return {
    score: 0,
    baseScore: 0,
    components: [],
    penalties: [{ key: "no-data", label: "No data", points: 0, detail: reason }],
    penaltyTotal: 0,
  };
}
