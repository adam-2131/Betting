/**
 * Query-string parsing for the Opportunities filters.
 *
 * Deliberately NOT a `"use client"` module. The page is a server component and reads
 * `searchParams` there, while the filter bar is a client component that renders the same options
 * — so these helpers have to be importable from both. Putting them next to the `"use client"`
 * directive makes them client-only exports, and calling one from the server throws at request
 * time rather than at build time.
 */
import { Category } from "@prisma/client";

export const RESOLUTION_WINDOWS: Array<{ value: string; label: string; hours: number | null }> = [
  { value: "any", label: "Any time", hours: null },
  { value: "24h", label: "24 hours", hours: 24 },
  { value: "3d", label: "3 days", hours: 72 },
  { value: "7d", label: "7 days", hours: 168 },
  { value: "30d", label: "30 days", hours: 720 },
];

/**
 * Cash Soon windows. Filters on estimated SETTLEMENT rather than on the market's close date —
 * for a game market Polymarket's end date is kickoff, and capital is not free until the game has
 * finished and the market settles.
 */
export const SETTLEMENT_WINDOWS: Array<{ value: string; label: string; hours: number }> = [
  { value: "24h", label: "24 hours", hours: 24 },
  { value: "3d", label: "3 days", hours: 72 },
  { value: "7d", label: "7 days", hours: 168 },
  { value: "14d", label: "14 days", hours: 336 },
  { value: "30d", label: "30 days", hours: 720 },
];

export const DEFAULT_SETTLEMENT_WINDOW = "7d";

export function settlementHours(value: string | undefined): number {
  return SETTLEMENT_WINDOWS.find((w) => w.value === value)?.hours ?? 168;
}

/** Sports windows, measured to kickoff rather than to settlement. */
export const SPORTS_WINDOWS: Array<{ value: string; label: string; hours: number }> = [
  { value: "12h", label: "Today", hours: 12 },
  { value: "48h", label: "48 hours", hours: 48 },
  { value: "4d", label: "4 days", hours: 96 },
  { value: "7d", label: "7 days", hours: 168 },
  { value: "14d", label: "14 days", hours: 336 },
];

export const DEFAULT_SPORTS_WINDOW = "4d";

export function sportsHours(value: string | undefined): number {
  return SPORTS_WINDOWS.find((w) => w.value === value)?.hours ?? 96;
}

export const CATEGORY_LABELS: Record<Category, string> = {
  [Category.POLITICS]: "Politics",
  [Category.ECONOMICS]: "Economics",
  [Category.SPORTS]: "Sports",
  [Category.CRYPTO]: "Crypto",
  [Category.ENTERTAINMENT]: "Entertainment",
  [Category.GEOPOLITICS]: "Geopolitics",
  [Category.OTHER]: "Other",
  [Category.UNKNOWN]: "Uncategorised",
};

export function resolutionHours(value: string | undefined): number | null {
  return RESOLUTION_WINDOWS.find((w) => w.value === value)?.hours ?? null;
}

/**
 * Parses the `category` parameter into real enum members, discarding anything else.
 *
 * The query string is user-editable and its values reach a Prisma enum filter, so unrecognised
 * input is dropped here rather than passed along.
 */
export function parseCategories(value: string | string[] | undefined): Category[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : value.split(",");
  const valid = new Set(Object.values(Category) as string[]);
  return raw
    .map((v) => v.trim().toUpperCase())
    .filter((v) => valid.has(v)) as Category[];
}
