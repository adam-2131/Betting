/**
 * Mapping Polymarket tags onto our fixed category enum.
 *
 * There is no canonical "category" field anywhere in the Gamma API. Events carry a `tags[]` array
 * that is extremely long-tail (a live sample included "caitlin clark", "Europa League", "FDIC",
 * "Timothée Chalamet"). So we match tag slugs/labels against keyword sets with a fixed priority
 * order, first match wins, and fall back to UNKNOWN rather than guessing.
 */
import { Category } from "@prisma/client";

/**
 * Tie-break order, used only when two categories score identically.
 *
 * POLITICS sits LAST deliberately. Polymarket applies the bare `politics` tag very liberally — a
 * politically-themed memecoin market carries both `crypto` and `politics` — so on a tie the more
 * specific domain is the better answer.
 */
const TIEBREAK_PRIORITY: Category[] = [
  Category.CRYPTO,
  Category.SPORTS,
  Category.ECONOMICS,
  Category.GEOPOLITICS,
  Category.ENTERTAINMENT,
  Category.POLITICS,
];

/**
 * Broad section tags Polymarket attaches liberally. They are weak evidence on their own, so they
 * score 1 instead of 3 — otherwise a market tagged `politics, crypto, memecoins` would be filed
 * under Politics purely because Politics was checked first.
 */
const GENERIC_TAGS = new Set([
  "politics", "crypto", "sports", "economy", "economics", "business", "finance", "world",
  "entertainment", "pop-culture", "geopolitics", "policy", "games", "tech", "science", "news",
]);

const SPECIFIC_WEIGHT = 3;
const GENERIC_WEIGHT = 1;

/**
 * Keyword sets matched against normalised tag slugs and labels.
 * Matching is substring-based on a slugified form, so "us-election" matches "election".
 */
const CATEGORY_KEYWORDS: Record<Category, string[]> = {
  [Category.POLITICS]: [
    "politics", "election", "elections", "president", "presidential", "senate", "house",
    "congress", "governor", "primary", "primaries", "democrat", "republican", "gop", "trump",
    "biden", "harris", "campaign", "impeach", "cabinet", "supreme-court", "scotus", "legislation",
    "policy", "polls", "approval", "ballot", "referendum", "parliament", "prime-minister",
    "political", "us-politics", "white-house", "vote", "voting", "nomination", "confirmation",
    "shutdown", "federal-government", "house-races", "senate-races",
  ],
  [Category.GEOPOLITICS]: [
    "geopolitics", "war", "ukraine", "russia", "israel", "gaza", "palestine", "iran", "china",
    "taiwan", "nato", "military", "conflict", "ceasefire", "peace", "sanctions", "nuclear",
    "north-korea", "middle-east", "invasion", "airstrike", "treaty", "diplomacy", "un",
    "international-affairs", "venezuela", "syria", "hezbollah", "hamas", "houthi", "coup",
    "world", "foreign-policy",
  ],
  [Category.ECONOMICS]: [
    "economy", "economics", "economic", "fed", "fed-rates", "federal-reserve", "fomc",
    "interest-rates", "inflation", "cpi", "gdp", "recession", "unemployment", "jobs", "jobless",
    "tariff", "tariffs", "trade", "treasury", "bonds", "stocks", "stock-market", "sp500",
    "nasdaq", "earnings", "ipo", "business", "finance", "financial", "housing", "oil",
    "commodities", "gold", "currency", "forex", "debt", "banking", "fdic", "powell",
    "rate-cut", "rate-hike", "jerome-powell", "economic-policy", "monetary-policy",
  ],
  [Category.CRYPTO]: [
    "crypto", "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "altcoins", "altcoin",
    "defi", "nft", "stablecoin", "usdc", "usdt", "binance", "coinbase", "sec-crypto", "etf",
    "blockchain", "web3", "memecoin", "memecoins", "dogecoin", "ripple", "xrp", "cardano",
    "token", "crypto-prices", "hyperliquid", "fdv", "airdrop", "pre-market", "market-cap",
  ],
  [Category.SPORTS]: [
    "sports", "nfl", "nba", "mlb", "nhl", "soccer", "football", "basketball", "baseball",
    "hockey", "tennis", "golf", "ufc", "mma", "boxing", "olympics", "worldcup", "world-cup",
    "fifa", "fifwc", "premier-league", "champions-league", "europa-league", "la-liga",
    "serie-a", "bundesliga", "ncaa", "cfb", "march-madness", "super-bowl", "f1", "formula-1",
    "nascar", "cricket", "rugby", "esports", "chess", "epl", "mls", "wnba", "games",
  ],
  [Category.ENTERTAINMENT]: [
    "entertainment", "pop-culture", "popculture", "movies", "film", "oscars", "academy-awards",
    "grammys", "emmys", "golden-globes", "music", "celebrity", "celebrities", "tv", "netflix",
    "streaming", "box-office", "awards", "kanye", "taylor-swift", "drake", "reality-tv",
    "eurovision", "book", "gaming", "video-games", "twitch", "youtube", "influencer",
    "time-person-of-the-year", "royal",
  ],
  // Terminal values, never keyword-matched.
  [Category.OTHER]: [],
  [Category.UNKNOWN]: [],
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True when a slugified tag matches a keyword as a whole hyphen-delimited token or substring. */
function tagMatches(tagSlug: string, keyword: string): boolean {
  if (tagSlug === keyword) return true;
  // Token boundary match, so "fed" matches "fed-rates" but not "federated".
  return tagSlug.startsWith(`${keyword}-`) || tagSlug.endsWith(`-${keyword}`) || tagSlug.includes(`-${keyword}-`);
}

/**
 * Scores every category against a tag list and returns the totals.
 *
 * Scoring rather than first-match-wins, because Polymarket markets routinely carry tags from
 * several domains at once. A Fed market tagged `fomc, economic-policy, fed-rates, jerome-powell`
 * used to land in Politics purely because `economic-policy` contains "policy" and Politics was
 * checked first; weighing the three specific economics tags against that one generic match gets
 * it right.
 */
export function scoreCategories(
  tags: Array<string | null | undefined>,
): Map<Category, number> {
  const slugs = tags
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map(slugify)
    .filter(Boolean);

  const scores = new Map<Category, number>();
  if (slugs.length === 0) return scores;

  for (const category of TIEBREAK_PRIORITY) {
    const keywords = CATEGORY_KEYWORDS[category];
    let score = 0;
    for (const slug of slugs) {
      // A tag contributes at most once per category, via its strongest match.
      let best = 0;
      for (const keyword of keywords) {
        if (!tagMatches(slug, keyword)) continue;
        const weight = GENERIC_TAGS.has(slug) ? GENERIC_WEIGHT : SPECIFIC_WEIGHT;
        best = Math.max(best, weight);
      }
      score += best;
    }
    if (score > 0) scores.set(category, score);
  }

  return scores;
}

/**
 * Resolves a category from a market's tag list (labels and/or slugs).
 * Returns OTHER when tags exist but match nothing, UNKNOWN when there are no tags at all.
 */
export function categoryFromTags(tags: Array<string | null | undefined>): Category {
  const hasTags = tags.some((t) => typeof t === "string" && t.length > 0);
  if (!hasTags) return Category.UNKNOWN;

  const scores = scoreCategories(tags);
  if (scores.size === 0) return Category.OTHER;

  let winner: Category = Category.OTHER;
  let best = 0;
  // TIEBREAK_PRIORITY order means the first category to reach the top score keeps it.
  for (const category of TIEBREAK_PRIORITY) {
    const score = scores.get(category) ?? 0;
    if (score > best) {
      best = score;
      winner = category;
    }
  }

  return winner;
}

/**
 * Last-resort classification from the question text, used only when tags produced OTHER/UNKNOWN.
 * Deliberately weaker than tag matching.
 */
export function categoryFromText(text: string | null | undefined): Category {
  if (!text) return Category.UNKNOWN;
  const slug = slugify(text);

  let winner: Category = Category.UNKNOWN;
  let best = 0;
  for (const category of TIEBREAK_PRIORITY) {
    let score = 0;
    for (const keyword of CATEGORY_KEYWORDS[category]) {
      if (keyword.length < 4) continue; // avoid "eth"/"btc"/"un" false positives in prose
      if (tagMatches(slug, keyword)) score++;
    }
    if (score > best) {
      best = score;
      winner = category;
    }
  }
  return winner;
}

/** Tags first, question text as fallback. */
export function resolveCategory(
  tags: Array<string | null | undefined>,
  questionText?: string | null,
): Category {
  const fromTags = categoryFromTags(tags);
  if (fromTags !== Category.OTHER && fromTags !== Category.UNKNOWN) return fromTags;

  const fromText = categoryFromText(questionText);
  if (fromText !== Category.UNKNOWN) return fromText;

  return fromTags;
}

export const CATEGORY_LABELS: Record<Category, string> = {
  [Category.POLITICS]: "Politics",
  [Category.ECONOMICS]: "Economics",
  [Category.SPORTS]: "Sports",
  [Category.CRYPTO]: "Crypto",
  [Category.ENTERTAINMENT]: "Entertainment",
  [Category.GEOPOLITICS]: "Geopolitics",
  [Category.OTHER]: "Other",
  [Category.UNKNOWN]: "Unknown",
};

/** Categories offered in filter UIs, in display order. */
export const FILTERABLE_CATEGORIES: Category[] = [
  Category.POLITICS,
  Category.ECONOMICS,
  Category.CRYPTO,
  Category.SPORTS,
  Category.ENTERTAINMENT,
  Category.GEOPOLITICS,
  Category.OTHER,
];

/** Specialties selectable when adding a trader. */
export const SPECIALTY_OPTIONS: Category[] = [
  ...FILTERABLE_CATEGORIES,
  Category.UNKNOWN,
];
