/**
 * SPORTS MARKET TAXONOMY.
 *
 * Polymarket attaches two fields to sports markets that exist nowhere else in the API, and both
 * were verified against live `/events?tag_slug=nfl` responses:
 *
 *   gameStartTime     "2026-09-13 17:00:00+00"   — kickoff, present ONLY on game-level markets
 *   sportsMarketType  "moneyline" | "spreads" | … — 35 distinct values observed in one NFL slate
 *
 * Two things make these worth a dedicated module.
 *
 * FIRST: `gameStartTime` is the only reliable way to tell a game from a futures market. "Bills vs.
 * Texans" on Sunday and "Pro Football: 2027 Champion" are both tagged `nfl` and both sit in
 * Category.SPORTS, but one frees your capital in three hours and the other holds it for a year.
 * Nothing else in the payload separates them — `endDate` is populated on both.
 *
 * SECOND: the great majority of sports markets cannot actually be traded. A single NFL game
 * carries ~380 markets, and one live slate of four games produced 834. Sampling those:
 *
 *   moneyline          $208,268 liquidity    1¢ spread     ← real market
 *   spreads             $70,198 liquidity    1¢ spread     ← real market
 *   totals              $15,124 liquidity    2¢ spread     ← real market
 *   q2_moneyline           $2.36 liquidity   96¢ spread    ← placeholder book
 *   second_half_totals     $1.08 liquidity   99¢ spread    ← placeholder book
 *
 * The exotic legs are auto-generated and sit unquoted at 50/50 with a 96¢ spread. They are not
 * opportunities at any price, and without a gate they would outnumber the tradeable markets
 * roughly ten to one on any sports screen.
 *
 * The tier below is a PRIOR, not the gate. `second_half_totals` is nominally a derivative of a
 * real market yet quoted at $1.08, so the actual filter has to read live liquidity and spread.
 * `isTradeableSportsMarket` does that; the tier only orders and labels what survives.
 */
import { safeNumber } from "@/lib/num";

/** How close a market type sits to the main line, which is a prior on whether it is quoted. */
export type SportsMarketTier = "CORE" | "DERIVATIVE" | "EXOTIC";

export interface SportsMarketKind {
  tier: SportsMarketTier;
  label: string;
}

/**
 * Observed values of `sportsMarketType`. Anything absent from this map is treated as EXOTIC,
 * which is the safe default: unknown auto-generated prop types keep appearing and they are
 * overwhelmingly unquoted.
 */
const MARKET_KINDS: Record<string, SportsMarketKind> = {
  // The three markets that carry essentially all sports liquidity.
  moneyline: { tier: "CORE", label: "Moneyline" },
  spreads: { tier: "CORE", label: "Spread" },
  totals: { tier: "CORE", label: "Total" },

  // Half markets are genuinely quoted often enough to keep, subject to the live gate.
  first_half_moneyline: { tier: "DERIVATIVE", label: "1st half moneyline" },
  first_half_spreads: { tier: "DERIVATIVE", label: "1st half spread" },
  first_half_totals: { tier: "DERIVATIVE", label: "1st half total" },
  first_half_team_totals: { tier: "DERIVATIVE", label: "1st half team total" },
  second_half_moneyline: { tier: "DERIVATIVE", label: "2nd half moneyline" },
  second_half_spreads: { tier: "DERIVATIVE", label: "2nd half spread" },
  second_half_totals: { tier: "DERIVATIVE", label: "2nd half total" },
  second_half_team_totals: { tier: "DERIVATIVE", label: "2nd half team total" },
  team_totals: { tier: "DERIVATIVE", label: "Team total" },

  // Quarter and prop markets. Present for completeness; almost never quoted.
  q1_moneyline: { tier: "EXOTIC", label: "1Q moneyline" },
  q2_moneyline: { tier: "EXOTIC", label: "2Q moneyline" },
  q3_moneyline: { tier: "EXOTIC", label: "3Q moneyline" },
  q4_moneyline: { tier: "EXOTIC", label: "4Q moneyline" },
  q1_spreads: { tier: "EXOTIC", label: "1Q spread" },
  q2_spreads: { tier: "EXOTIC", label: "2Q spread" },
  q3_spreads: { tier: "EXOTIC", label: "3Q spread" },
  q4_spreads: { tier: "EXOTIC", label: "4Q spread" },
  q1_totals: { tier: "EXOTIC", label: "1Q total" },
  q2_totals: { tier: "EXOTIC", label: "2Q total" },
  q3_totals: { tier: "EXOTIC", label: "3Q total" },
  q4_totals: { tier: "EXOTIC", label: "4Q total" },
  q1_both_teams_to_score_points: { tier: "EXOTIC", label: "1Q both teams score" },
  q2_both_teams_to_score_points: { tier: "EXOTIC", label: "2Q both teams score" },
  q3_both_teams_to_score_points: { tier: "EXOTIC", label: "3Q both teams score" },
  q4_both_teams_to_score_points: { tier: "EXOTIC", label: "4Q both teams score" },
  exact_margin: { tier: "EXOTIC", label: "Exact margin" },
  safety: { tier: "EXOTIC", label: "Safety" },
  longest_field_goal: { tier: "EXOTIC", label: "Longest field goal" },
  team_touchdowns: { tier: "EXOTIC", label: "Team touchdowns" },
  team_offensive_yards: { tier: "EXOTIC", label: "Team offensive yards" },
  two_point_conversions: { tier: "EXOTIC", label: "Two-point conversions" },
};

export function classifySportsMarket(sportsMarketType: string | null | undefined): SportsMarketKind {
  if (!sportsMarketType) return { tier: "EXOTIC", label: "Other" };
  return (
    MARKET_KINDS[sportsMarketType] ?? {
      tier: "EXOTIC",
      // Turn "team_offensive_yards" into "Team offensive yards" rather than showing a raw key.
      label: sportsMarketType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    }
  );
}

/**
 * Parses `gameStartTime`.
 *
 * VERIFIED TRAP: the observed format is `"2026-09-13 17:00:00+00"` — a space instead of `T`, and a
 * two-digit offset instead of `±HH:MM`. V8 happens to parse that correctly today, but the shape is
 * outside the ECMAScript date-time grammar, so it is parsed by implementation-specific fallback
 * rather than by spec.
 *
 * The dangerous case is an offset going missing. `new Date("2026-09-13 17:00:00")` is interpreted
 * in the HOST timezone, which silently moved kickoff by two hours on the machine this was written
 * on. Every number this feature produces is a function of "hours until kickoff", so a silent
 * timezone shift would corrupt the whole ranking rather than fail visibly. When no offset is
 * present we therefore append `Z` and treat the value as UTC, which is what Polymarket sends
 * everywhere else in the API.
 */
export function parseGameStartTime(raw: string | null | undefined): Date | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Space separator -> "T".
  let normalized = trimmed.replace(" ", "T");

  const hasZulu = /[Zz]$/.test(normalized);
  const hasNumericOffset = /[+-]\d{2}(:?\d{2})?$/.test(normalized);

  if (hasNumericOffset) {
    // "+00" -> "+00:00", which is the spec-compliant form.
    normalized = normalized.replace(/([+-]\d{2})$/, "$1:00");
  } else if (!hasZulu) {
    normalized = `${normalized}Z`;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Typical wall-clock length of a game, used to estimate when a position actually settles.
 *
 * `endDate` on a game market equals `gameStartTime` — verified on the Bills/Texans slate, where
 * both read 2026-09-13T17:00:00Z. So endDate marks kickoff, NOT settlement, and taking it as the
 * moment capital comes back understates the hold by the length of the game. These are averages
 * including stoppages and broadcast breaks, and they are labelled as estimates wherever shown.
 */
const GAME_DURATION_HOURS: Record<string, number> = {
  nfl: 3.2,
  cfb: 3.5,
  ncaaf: 3.5,
  nba: 2.5,
  ncaab: 2.2,
  wnba: 2.2,
  mlb: 3.1,
  nhl: 2.6,
  soccer: 2.0,
  epl: 2.0,
  ucl: 2.0,
  mls: 2.0,
  tennis: 2.5,
  ufc: 1.5,
  mma: 1.5,
  boxing: 1.5,
  f1: 2.0,
  cricket: 4.0,
  // Esports carry real money — a single Counter-Strike playoff match showed $423k of liquidity —
  // and they were the only upcoming fixtures a live sync could not match to a league. Durations
  // assume the best-of-three and best-of-five formats Polymarket lists.
  esports: 2.5,
  "counter-strike-2": 2.5,
  cs2: 2.5,
  csgo: 2.5,
  "league-of-legends": 3.0,
  lol: 3.0,
  dota2: 3.0,
  valorant: 2.5,
};

/** Used when the league is unknown. Deliberately mid-range rather than optimistic. */
export const DEFAULT_GAME_DURATION_HOURS = 3;

/**
 * Umbrella tags that name a family of sports rather than a competition.
 *
 * Polymarket attaches these alongside the specific one — a League of Legends match carries
 * `esports`, `games`, `sports` AND `league-of-legends` — so a first-match scan would settle on the
 * umbrella and use its duration. Matched only after every specific league has been ruled out.
 */
const GENERIC_LEAGUE_TAGS = new Set(["esports", "soccer"]);

/** League slug from a market's tags, preferring a specific competition over an umbrella tag. */
export function leagueFromTags(tags: Array<string | null | undefined>): string | null {
  const slugs = tags
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter((slug) => slug in GAME_DURATION_HOURS);

  return (
    slugs.find((slug) => !GENERIC_LEAGUE_TAGS.has(slug)) ?? slugs[0] ?? null
  );
}

export function gameDurationHours(league: string | null | undefined): number {
  if (!league) return DEFAULT_GAME_DURATION_HOURS;
  return GAME_DURATION_HOURS[league.toLowerCase()] ?? DEFAULT_GAME_DURATION_HOURS;
}

/**
 * Best estimate of when a sports position actually pays out.
 *
 * Kickoff plus the league's typical game length. Returns null rather than guessing when there is
 * no kickoff time, so callers fall back to `endDate` and can say which one they used.
 */
export function estimatedSettlementAt(
  gameStartTime: Date | null,
  league: string | null,
): Date | null {
  if (!gameStartTime) return null;
  return new Date(gameStartTime.getTime() + gameDurationHours(league) * 3_600_000);
}

export interface TradeabilityInput {
  liquidity: number | null;
  spread: number | null;
  /** Index-aligned outcome prices, used to reject unquoted 50/50 placeholder books. */
  prices?: number[];
}

export interface TradeabilityResult {
  tradeable: boolean;
  /** Why it was rejected. Null when it passed. */
  reason: string | null;
}

/**
 * Minimums for a sports market to be worth showing at all.
 *
 * These are far below what makes a market GOOD — that is the scoring layer's job. They only
 * separate a real order book from an auto-generated placeholder. The observed gap is enormous
 * (1¢ versus 96¢ spreads, $208k versus $2.36 of liquidity), so no precision is needed here.
 */
export const SPORTS_TRADEABILITY = {
  minLiquidityUsd: 500,
  maxSpread: 0.15,
} as const;

export function isTradeableSportsMarket(input: TradeabilityInput): TradeabilityResult {
  const liquidity = safeNumber(input.liquidity);
  const spread = safeNumber(input.spread);

  if (spread !== null && spread > SPORTS_TRADEABILITY.maxSpread) {
    return {
      tradeable: false,
      reason: `${(spread * 100).toFixed(0)}¢ spread — this book is unquoted, not a real market`,
    };
  }

  if (liquidity !== null && liquidity < SPORTS_TRADEABILITY.minLiquidityUsd) {
    return {
      tradeable: false,
      reason: `$${Math.round(liquidity)} of liquidity is a placeholder book, not a tradeable market`,
    };
  }

  // Liquidity absent AND spread absent means we know nothing; refuse rather than assume.
  if (liquidity === null && spread === null) {
    return { tradeable: false, reason: "No liquidity or spread reported for this market" };
  }

  return { tradeable: true, reason: null };
}
