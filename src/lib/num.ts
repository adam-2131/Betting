/**
 * Numeric safety and formatting.
 *
 * The rule for the whole app: NaN and Infinity never reach the UI. Anything genuinely unknown is
 * `null`, and `null` renders as "Unavailable" — not as 0, which would silently look like real data.
 */

export const UNAVAILABLE = "Unavailable";

/** Coerces anything to a finite number, or null. This is the gate every computed value passes. */
export function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Division that yields null instead of Infinity/NaN on a zero or missing denominator. */
export function safeDivide(numerator: unknown, denominator: unknown): number | null {
  const a = safeNumber(numerator);
  const b = safeNumber(denominator);
  if (a === null || b === null || b === 0) return null;
  const result = a / b;
  return Number.isFinite(result) ? result : null;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Clamp into 0..100 and round to 1dp. Used for every displayed score. */
export function clampScore(value: unknown): number {
  const n = safeNumber(value);
  if (n === null) return 0;
  return Math.round(clamp(n, 0, 100) * 10) / 10;
}

export function round(value: number | null, decimals = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function sum(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) {
    const n = safeNumber(v);
    if (n !== null) total += n;
  }
  return total;
}

export function mean(values: Array<number | null | undefined>): number | null {
  const nums = values.map(safeNumber).filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function median(values: Array<number | null | undefined>): number | null {
  const nums = values
    .map(safeNumber)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

export function stdDev(values: Array<number | null | undefined>): number | null {
  const nums = values.map(safeNumber).filter((n): n is number => n !== null);
  if (nums.length < 2) return null;
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((acc, n) => acc + (n - avg) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

/** Weighted mean. Returns null if no positive weights, so it can never divide by zero. */
export function weightedMean(
  entries: Array<{ value: number | null | undefined; weight: number | null | undefined }>,
): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const { value, weight } of entries) {
    const v = safeNumber(value);
    const w = safeNumber(weight);
    if (v === null || w === null || w <= 0) continue;
    weighted += v * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
}

/**
 * Herfindahl-Hirschman index of a set of exposures, 0..1.
 * 1 means a single holding is everything; near 0 means broadly spread.
 */
export function herfindahl(values: Array<number | null | undefined>): number | null {
  const nums = values.map(safeNumber).filter((n): n is number => n !== null && n > 0);
  const total = nums.reduce((a, b) => a + b, 0);
  if (total <= 0 || nums.length === 0) return null;
  return nums.reduce((acc, n) => acc + (n / total) ** 2, 0);
}

/**
 * Maps a value onto 0..100 across [min, max], clamped at both ends.
 * The workhorse for turning raw metrics into score components.
 */
export function scaleToScore(value: number | null, min: number, max: number): number | null {
  const v = safeNumber(value);
  if (v === null) return null;
  if (max === min) return 50;
  return clamp(((v - min) / (max - min)) * 100, 0, 100);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatUsd(value: number | null | undefined, decimals?: number): string {
  const n = safeNumber(value);
  if (n === null) return UNAVAILABLE;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (decimals === undefined) {
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
    if (abs >= 1000) return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    return `${sign}$${abs.toFixed(2)}`;
  }
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Signed USD, for PnL where the sign carries meaning. */
export function formatSignedUsd(value: number | null | undefined): string {
  const n = safeNumber(value);
  if (n === null) return UNAVAILABLE;
  return `${n >= 0 ? "+" : "-"}${formatUsd(Math.abs(n))}`;
}

/** A 0..1 price as cents, the way Polymarket displays it. */
export function formatCents(price: number | null | undefined, decimals = 1): string {
  const n = safeNumber(price);
  if (n === null) return UNAVAILABLE;
  return `${(n * 100).toFixed(decimals)}¢`;
}

/** A signed price delta in cents — this is how the entry gap is displayed. */
export function formatSignedCents(delta: number | null | undefined, decimals = 1): string {
  const n = safeNumber(delta);
  if (n === null) return UNAVAILABLE;
  return `${n >= 0 ? "+" : "-"}${(Math.abs(n) * 100).toFixed(decimals)}¢`;
}

/** A 0..1 fraction as a percentage. */
export function formatPercent(fraction: number | null | undefined, decimals = 1): string {
  const n = safeNumber(fraction);
  if (n === null) return UNAVAILABLE;
  return `${(n * 100).toFixed(decimals)}%`;
}

export function formatSignedPercent(fraction: number | null | undefined, decimals = 1): string {
  const n = safeNumber(fraction);
  if (n === null) return UNAVAILABLE;
  return `${n >= 0 ? "+" : "-"}${(Math.abs(n) * 100).toFixed(decimals)}%`;
}

export function formatNumber(value: number | null | undefined, decimals = 0): string {
  const n = safeNumber(value);
  if (n === null) return UNAVAILABLE;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Whole dollars with thousands separators, locale-independent.
 * Used inside scoring explanation strings, which must read identically on every machine —
 * a bare `toLocaleString()` picks up the host locale and yields things like `1’400’000`.
 */
export function usdPlain(value: number | null | undefined): string {
  const n = safeNumber(value);
  if (n === null) return UNAVAILABLE;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Integer with thousands separators, locale-independent. */
export function intPlain(value: number | null | undefined): string {
  const n = safeNumber(value);
  if (n === null) return UNAVAILABLE;
  return Math.round(n).toLocaleString("en-US");
}

export function formatScore(value: number | null | undefined): string {
  const n = safeNumber(value);
  if (n === null) return UNAVAILABLE;
  return String(Math.round(n));
}

/** Compact duration, e.g. "4.2 min", "3.1 h", "12 d". */
export function formatDuration(seconds: number | null | undefined): string {
  const n = safeNumber(seconds);
  if (n === null || n < 0) return UNAVAILABLE;
  if (n < 60) return `${n.toFixed(0)} sec`;
  if (n < 3600) return `${(n / 60).toFixed(1)} min`;
  if (n < 86_400) return `${(n / 3600).toFixed(1)} h`;
  return `${(n / 86_400).toFixed(1)} d`;
}

/** Time remaining until a date, or null-safe "Unavailable". */
export function formatTimeUntil(date: Date | string | null | undefined, now = new Date()): string {
  if (!date) return UNAVAILABLE;
  const target = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(target.getTime())) return UNAVAILABLE;
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "Resolving";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}

export function formatRelativeTime(date: Date | string | null | undefined, now = new Date()): string {
  if (!date) return UNAVAILABLE;
  const target = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(target.getTime())) return UNAVAILABLE;
  const seconds = Math.max(0, (now.getTime() - target.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d ago`;
  return target.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
