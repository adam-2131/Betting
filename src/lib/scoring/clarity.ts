/**
 * Resolution-clarity heuristic.
 *
 * Polymarket exposes no "how ambiguous is this market" field, so this is a text scan of the
 * resolution criteria. It is a weak signal and the UI always labels it as a heuristic — it feeds
 * only 5% of the Opportunity Score and can trigger an AMBIGUOUS_RESOLUTION warning badge.
 *
 * Pure and synchronous: no network, no clock.
 */

export interface ClarityResult {
  /** 0-100. Higher means the criteria read as more objective. */
  score: number;
  /** Human-readable reasons, shown verbatim in the UI. */
  flags: string[];
}

/** Phrases that suggest subjective or contested resolution. */
const AMBIGUITY_PATTERNS: Array<{ pattern: RegExp; flag: string; penalty: number }> = [
  {
    pattern: /\b(subjective|at the discretion|sole discretion|judgment of|deemed by)\b/i,
    flag: "Resolution depends on discretion or judgement",
    penalty: 25,
  },
  {
    pattern: /\b(consensus of|credible report|credible sources?|reputable sources?|media report)/i,
    flag: "Resolves on media consensus rather than a single named source",
    penalty: 15,
  },
  {
    pattern: /\b(ambiguous|unclear|dispute|disputed|contested|controvers)/i,
    flag: "Criteria reference disputes or ambiguity",
    penalty: 15,
  },
  {
    pattern: /\b(may|might|could) be (resolved|considered|interpreted)/i,
    flag: "Conditional language in the resolution criteria",
    penalty: 10,
  },
  {
    pattern: /\b(substantially|significantly|meaningfully|materially|approximately|roughly|about)\b/i,
    flag: "Uses qualitative thresholds",
    penalty: 8,
  },
  {
    pattern: /\b(if no|in the event that no|otherwise this market)\b/i,
    flag: "Contains fallback branches",
    penalty: 5,
  },
];

/** Phrases that suggest objective, mechanically checkable resolution. */
const CLARITY_PATTERNS: Array<{ pattern: RegExp; bonus: number }> = [
  { pattern: /https?:\/\/\S+/i, bonus: 12 }, // links a named source
  { pattern: /\b(official|officially)\b/i, bonus: 8 },
  { pattern: /\b(according to)\b/i, bonus: 6 },
  { pattern: /\b\d{1,2}:\d{2}\s?(am|pm|et|utc)/i, bonus: 5 }, // a precise deadline
  { pattern: /\b(exceeds?|greater than|less than|at least|equal to|>=|<=)\b/i, bonus: 6 },
];

const BASE_SCORE = 70;
const MIN_USEFUL_DESCRIPTION = 80;

export function scoreResolutionClarity(input: {
  description: string | null | undefined;
  resolutionSource?: string | null;
  question?: string | null;
}): ClarityResult {
  const description = (input.description ?? "").trim();
  const flags: string[] = [];

  if (description.length === 0) {
    return { score: 35, flags: ["No resolution criteria published"] };
  }

  let score = BASE_SCORE;

  if (description.length < MIN_USEFUL_DESCRIPTION) {
    score -= 15;
    flags.push("Very short resolution criteria");
  } else if (description.length > 400) {
    // Long criteria are usually thorough, but only mildly credited.
    score += 5;
  }

  if (input.resolutionSource && input.resolutionSource.trim().length > 0) {
    score += 10;
  }

  for (const { pattern, flag, penalty } of AMBIGUITY_PATTERNS) {
    if (pattern.test(description)) {
      score -= penalty;
      flags.push(flag);
    }
  }

  for (const { pattern, bonus } of CLARITY_PATTERNS) {
    if (pattern.test(description)) score += bonus;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    flags,
  };
}

/** Threshold below which the AMBIGUOUS_RESOLUTION badge is shown. */
export const AMBIGUOUS_CLARITY_THRESHOLD = 45;
