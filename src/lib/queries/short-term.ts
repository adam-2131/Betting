/**
 * Read-side queries for the Cash Soon and Sports screens.
 *
 * Both read the same `Opportunity` rows the main list does — a short-horizon play is not a
 * different kind of object, just a different question asked of the same object — but they sort by
 * `horizonScore` rather than `score` and filter on the settlement window.
 *
 * Anything excluded is COUNTED rather than silently dropped, so a short list can be shown as a
 * real answer instead of looking like missing data.
 */
import type { Category, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { ScoreComponent, ScorePenalty } from "@/lib/scoring/types";
import type { GamePhase, LineVerdict } from "@/lib/scoring/sports";

/**
 * `Opportunity.horizon` as it comes BACK from the database.
 *
 * Identical to `HorizonResult` except that JSON has no Date type. Nothing here is a Date, and the
 * fields that would be live in the `settlesAt` column instead.
 */
export interface StoredHorizon {
  score: number;
  baseScore: number;
  components: ScoreComponent[];
  penalties: ScorePenalty[];
  penaltyTotal: number;
  hoursToSettlement: number | null;
  capitalDays: number | null;
  capitalDaysFloored: boolean;
  effectivePrice: number | null;
  grossEdgePoints: number | null;
  netEdgePoints: number | null;
  edgeRetention: number | null;
  expectedReturnOnCapital: number | null;
  downsideReturnOnCapital: number | null;
  returnPerDay: number | null;
  upsideIfRight: number | null;
  estimatedWinProbability: number | null;
  verdict: string;
}

/** `Opportunity.sports` as stored. `settlesAt` is an ISO STRING here, not a Date. */
export interface StoredSportsAngle {
  isGame: boolean;
  phase: GamePhase;
  hoursToKickoff: number | null;
  settlesAt: string | null;
  kind: { tier: string; label: string };
  tradeable: { tradeable: boolean; reason: string | null };
  lateMoneyUsd: number;
  earlyMoneyUsd: number;
  lateMoneyShare: number | null;
  lineMovePoints: number | null;
  lineVerdict: LineVerdict;
  notes: string[];
  warnings: string[];
}

const shortTermInclude = {
  signals: { orderBy: { type: "asc" } },
  market: {
    select: {
      id: true,
      conditionId: true,
      question: true,
      slug: true,
      eventId: true,
      eventSlug: true,
      eventTitle: true,
      category: true,
      outcomes: true,
      endDate: true,
      liquidity: true,
      volume24hr: true,
      spread: true,
      clarityScore: true,
      gameStartTime: true,
      sportsMarketType: true,
      league: true,
    },
  },
} satisfies Prisma.OpportunityInclude;

export type ShortTermRow = Prisma.OpportunityGetPayload<{ include: typeof shortTermInclude }>;

export function readHorizon(row: ShortTermRow): StoredHorizon | null {
  return (row.horizon as unknown as StoredHorizon | null) ?? null;
}

export function readSports(row: ShortTermRow): StoredSportsAngle | null {
  return (row.sports as unknown as StoredSportsAngle | null) ?? null;
}

// ---------------------------------------------------------------------------
// Cash Soon
// ---------------------------------------------------------------------------

/**
 * How to order the board.
 *
 * Return per day is the ranking the score is built around, but it is the right question only for
 * someone reinvesting continuously. Betting a flat dollar at a time is a different problem: the
 * denominator never changes, so how often a bet lands and what it pays when it does matter more
 * than how fast the capital recycles. Sorting on the underlying figure rather than re-scoring
 * keeps each ordering honest about what it is sorting on.
 */
export type CashSoonSort =
  /** Expected return per day of capital tied up. */
  | "perDay"
  /** The model's estimated chance of the position paying at all. */
  | "chance"
  /** Largest profit on a fixed stake, which is simply the cheapest entry. */
  | "profit";

export const CASH_SOON_SORTS: Array<{ value: CashSoonSort; label: string; hint: string }> = [
  { value: "perDay", label: "Return per day", hint: "Best use of capital over time" },
  { value: "chance", label: "Most likely to hit", hint: "Highest estimated chance of paying" },
  { value: "profit", label: "Biggest payout", hint: "Most profit per $1 staked, and least likely" },
];

export interface CashSoonFilters {
  /** Only positions whose capital comes back inside this many hours. */
  withinHours?: number;
  categories?: Category[];
  minHorizonScore?: number;
  /**
   * Drop rows whose edge does not survive the spread. On by default: a board answering "what
   * should I put money into" should not lead with trades that lose to execution.
   */
  requirePositiveEdge?: boolean;
  sort?: CashSoonSort;
  limit?: number;
}

export interface CashSoonResult {
  rows: ShortTermRow[];
  /** Everything with a settlement date inside the window, before the quality filters. */
  inWindow: number;
  /** Excluded because the spread consumed the whole estimated edge. */
  edgeEatenBySpread: number;
  /** Excluded by the score floor. */
  belowScoreFloor: number;
}

export async function listCashSoon(filters: CashSoonFilters = {}): Promise<CashSoonResult> {
  const {
    withinHours = 168,
    categories,
    minHorizonScore,
    requirePositiveEdge = true,
    sort = "perDay",
    limit = 50,
  } = filters;

  const now = new Date();
  const cutoff = new Date(now.getTime() + withinHours * 3_600_000);

  const where: Prisma.OpportunityWhereInput = {
    settlesAt: { gt: now, lte: cutoff },
  };
  if (categories?.length) where.market = { category: { in: categories } };

  // Nulls always sort last, so rows that could not be scored never displace ones that could.
  const orderBy: Prisma.OpportunityOrderByWithRelationInput[] =
    sort === "chance"
      ? // modelEstimateMid IS the estimated chance of being paid.
        [{ modelEstimateMid: { sort: "desc", nulls: "last" } }]
      : sort === "profit"
        ? // A fixed stake profits most where the entry is cheapest, which is also where it wins
          // least often. Ascending price is exactly that ordering.
          [{ effectivePrice: { sort: "asc", nulls: "last" } }]
        : [{ horizonScore: { sort: "desc", nulls: "last" } }];

  const rows = await prisma.opportunity.findMany({
    where,
    include: shortTermInclude,
    orderBy,
    take: 500,
  });

  let edgeEatenBySpread = 0;
  let belowScoreFloor = 0;

  const kept = rows.filter((row) => {
    if (requirePositiveEdge && (row.netEdgePoints === null || row.netEdgePoints <= 0)) {
      edgeEatenBySpread++;
      return false;
    }
    if (minHorizonScore != null && (row.horizonScore ?? 0) < minHorizonScore) {
      belowScoreFloor++;
      return false;
    }
    return true;
  });

  return {
    rows: kept.slice(0, limit),
    inWindow: rows.length,
    edgeEatenBySpread,
    belowScoreFloor,
  };
}

// ---------------------------------------------------------------------------
// Sports
// ---------------------------------------------------------------------------

/** Sports opportunities collected under the game they belong to. */
export interface GameGroup {
  eventId: string | null;
  title: string;
  league: string | null;
  /** Kickoff, taken from the market rather than from the JSON blob. */
  gameStartTime: Date | null;
  phase: GamePhase;
  rows: ShortTermRow[];
}

export interface SportsFilters {
  /** Only games kicking off inside this many hours. */
  withinHours?: number;
  /**
   * Hide markets whose book is a placeholder. On by default — one four-game NFL slate carried 834
   * markets and the great majority are quoted at 50/50 behind a 96¢ spread.
   */
  tradeableOnly?: boolean;
  /** Hide games already underway. On by default: there is no live score feed here. */
  excludeInPlay?: boolean;
  limit?: number;
}

export interface SportsResult {
  games: GameGroup[];
  /** Sports sides scored, before any of the filters below. */
  totalSportsSides: number;
  /** Excluded because the book is an unquoted placeholder. */
  untradeable: number;
  /** Excluded because the game is already being played. */
  inPlay: number;
  /** Season futures, which have no kickoff and are not part of a slate. */
  seasonFutures: number;
}

export async function listSportsGames(filters: SportsFilters = {}): Promise<SportsResult> {
  const { withinHours = 96, tradeableOnly = true, excludeInPlay = true, limit = 40 } = filters;

  const now = new Date();
  const cutoff = new Date(now.getTime() + withinHours * 3_600_000);

  const all = await prisma.opportunity.findMany({
    where: { market: { category: "SPORTS" } },
    include: shortTermInclude,
    orderBy: [{ horizonScore: { sort: "desc", nulls: "last" } }],
    take: 500,
  });

  let untradeable = 0;
  let inPlay = 0;
  let seasonFutures = 0;

  const kept: ShortTermRow[] = [];

  for (const row of all) {
    const kickoff = row.market.gameStartTime;

    // No kickoff means a season future — a real market, but not part of any slate.
    if (!kickoff) {
      seasonFutures++;
      continue;
    }
    if (kickoff > cutoff) continue;

    const angle = readSports(row);
    if (tradeableOnly && angle && !angle.tradeable.tradeable) {
      untradeable++;
      continue;
    }
    if (excludeInPlay && (row.gamePhase === "IN_PLAY" || row.gamePhase === "ENDED")) {
      inPlay++;
      continue;
    }
    kept.push(row);
  }

  // Group by event so both sides of a game, and its spread and total, sit together.
  const groups = new Map<string, GameGroup>();
  for (const row of kept) {
    const key = row.market.eventId ?? row.market.eventSlug ?? row.market.id;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    groups.set(key, {
      eventId: row.market.eventId,
      title: row.market.eventTitle ?? row.market.question,
      league: row.market.league,
      gameStartTime: row.market.gameStartTime,
      phase: (row.gamePhase as GamePhase | null) ?? "NOT_A_GAME",
      rows: [row],
    });
  }

  const games = [...groups.values()]
    // Soonest kickoff first: a sports slate is read chronologically, not by score.
    .sort((a, b) => {
      const aTime = a.gameStartTime?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bTime = b.gameStartTime?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    })
    .slice(0, limit);

  // Best side first within a game.
  for (const game of games) {
    game.rows.sort((a, b) => (b.horizonScore ?? 0) - (a.horizonScore ?? 0));
  }

  return {
    games,
    totalSportsSides: all.length,
    untradeable,
    inPlay,
    seasonFutures,
  };
}

/** What you have already logged on a market side, keyed `marketId:outcomeIndex`. */
export interface LoggedPosition {
  count: number;
  totalStake: number;
  /** Volume-weighted average of what you paid, so repeat bets read as one position. */
  averagePrice: number;
}

/**
 * Bets already logged, so a card can say so.
 *
 * `BetLog` stores a market and an outcome index rather than an opportunity id, and `Opportunity`
 * is unique on that same pair — so they join on it without a foreign key. That is deliberate: an
 * opportunity row is deleted and recreated whenever it stops and starts qualifying, and a bet must
 * outlive that. It is a record of something you did, not of a row that happened to exist.
 */
export async function listLoggedPositions(): Promise<Map<string, LoggedPosition>> {
  const bets = await prisma.betLog.findMany({
    select: { marketId: true, outcomeIndex: true, stake: true, entryPrice: true },
  });

  const byKey = new Map<string, LoggedPosition & { notional: number }>();
  for (const bet of bets) {
    const key = `${bet.marketId}:${bet.outcomeIndex}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      existing.totalStake += bet.stake;
      existing.notional += bet.stake * bet.entryPrice;
    } else {
      byKey.set(key, {
        count: 1,
        totalStake: bet.stake,
        notional: bet.stake * bet.entryPrice,
        averagePrice: bet.entryPrice,
      });
    }
  }

  const result = new Map<string, LoggedPosition>();
  for (const [key, value] of byKey) {
    result.set(key, {
      count: value.count,
      totalStake: value.totalStake,
      averagePrice: value.totalStake > 0 ? value.notional / value.totalStake : value.averagePrice,
    });
  }
  return result;
}

export function loggedKey(row: ShortTermRow): string {
  return `${row.marketId}:${row.outcomeIndex}`;
}

export interface ShortTermStats {
  /** Sides settling within 24 hours. */
  settlingToday: number;
  /** Sides settling within seven days. */
  settlingThisWeek: number;
  /** Best return per day available inside the week, among rows with surviving edge. */
  bestReturnPerDay: number | null;
  /** Upcoming games with at least one scored side. */
  upcomingGames: number;
}

export async function getShortTermStats(): Promise<ShortTermStats> {
  const now = new Date();
  const day = new Date(now.getTime() + 24 * 3_600_000);
  const week = new Date(now.getTime() + 7 * 24 * 3_600_000);

  const [settlingToday, settlingThisWeek, best, games] = await Promise.all([
    prisma.opportunity.count({ where: { settlesAt: { gt: now, lte: day } } }),
    prisma.opportunity.count({ where: { settlesAt: { gt: now, lte: week } } }),
    prisma.opportunity.findFirst({
      where: { settlesAt: { gt: now, lte: week }, netEdgePoints: { gt: 0 } },
      orderBy: { returnPerDay: "desc" },
      select: { returnPerDay: true },
    }),
    prisma.opportunity.findMany({
      where: { market: { gameStartTime: { gt: now } } },
      select: { market: { select: { eventId: true } } },
      distinct: ["marketId"],
    }),
  ]);

  return {
    settlingToday,
    settlingThisWeek,
    bestReturnPerDay: best?.returnPerDay ?? null,
    upcomingGames: new Set(games.map((g) => g.market.eventId).filter(Boolean)).size,
  };
}
