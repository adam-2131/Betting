/**
 * WHICH WALLETS TO SYNC THIS PASS.
 *
 * A full sync of one wallet is expensive: positions, closed positions, activity, portfolio value
 * and traded count, with `/closed-positions` paginating fifty rows at a time so a deep history
 * costs twenty requests on its own. That cost is why the watchlist was capped at a hundred wallets
 * a pass, and the cap is what limits how many traders the product can meaningfully cover.
 *
 * Raising the cap alone does not work. Sync time grows linearly with the watchlist while the
 * useful signal does not: a wallet that last traded in March produces exactly the same positions
 * this hour as it did last hour, and re-reading it costs the same as re-reading a wallet that is
 * trading right now.
 *
 * So the budget is spent by value rather than spread evenly. Wallets are tiered by how likely a
 * refresh is to change anything, and each tier gets its own minimum interval between syncs. A
 * watchlist of several thousand then costs roughly what a few hundred used to, because most of it
 * is not due on any given pass.
 *
 * THE RESERVATION IS THE LOAD-BEARING PART. Newly discovered wallets have never been synced, so we
 * know nothing about them — not their score, not their record, not whether they are a bot. That
 * makes them simultaneously the highest-value wallets to read and the easiest ones to starve. Sort
 * purely by tier and either failure mode appears: with five hundred hot wallets and a budget of
 * two hundred, discoveries never get synced and the discovery stage is pointless; with three
 * thousand new wallets, they consume every pass and the traders actually producing signals go
 * stale. A reserved SHARE of the budget avoids both: it guarantees new wallets a slice, and caps
 * them at it for as long as known wallets are competing for the same slots. When the known pool
 * cannot fill the budget the remainder goes back to new wallets rather than idling, since an
 * unused slot helps nobody.
 *
 * Pure and synchronous, so the policy can be tested without a database.
 */

export type SyncTier =
  /** Never synced. We know nothing about this wallet yet. */
  | "NEW"
  /** Strong record and trading right now. Most likely to have moved since last pass. */
  | "HOT"
  /** Traded recently, or scores well enough to be worth watching. */
  | "WARM"
  /** Synced before, quiet lately. */
  | "COLD"
  /** Long inactive, or its last sync failed. Backed off hard. */
  | "DORMANT";

export interface TraderSyncCandidate {
  id: string;
  wallet: string;
  lastSyncedAt: Date | null;
  /** Unix seconds of the most recent activity ingested for this wallet. */
  lastActivityTs: number | null;
  smartScore: number | null;
  /** True when the last sync attempt failed. Cleared by the next successful sync. */
  hasSyncError: boolean;
}

export interface TierPolicy {
  /** Minimum hours between syncs. A wallet is not eligible again until this has elapsed. */
  refreshHours: number;
  /** Sort order among due wallets. Lower goes first. */
  priority: number;
}

export const DEFAULT_TIER_POLICY: Record<SyncTier, TierPolicy> = {
  NEW: { refreshHours: 0, priority: 0 },
  HOT: { refreshHours: 2, priority: 1 },
  WARM: { refreshHours: 8, priority: 2 },
  COLD: { refreshHours: 24, priority: 3 },
  DORMANT: { refreshHours: 96, priority: 4 },
};

export interface ClassifyThresholds {
  /** Smart Trader Score at or above which a recently-active wallet counts as HOT. */
  hotScore: number;
  /** Smart Trader Score at or above which a quiet wallet is still WARM. */
  warmScore: number;
  /** Hours since last activity within which a wallet counts as currently trading. */
  hotActivityHours: number;
  /** Hours since last activity within which a wallet is still considered active. */
  warmActivityHours: number;
  /** Hours of silence after which a wallet is treated as dormant. */
  dormantActivityHours: number;
}

export const DEFAULT_CLASSIFY_THRESHOLDS: ClassifyThresholds = {
  // Matches `consensus.qualifiedTraderScore`: the bar for counting toward a consensus is the same
  // bar that makes a wallet worth refreshing often.
  hotScore: 60,
  warmScore: 45,
  hotActivityHours: 48,
  warmActivityHours: 24 * 14,
  dormantActivityHours: 24 * 90,
};

function hoursSince(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return (now.getTime() - date.getTime()) / 3_600_000;
}

function hoursSinceActivity(candidate: TraderSyncCandidate, now: Date): number | null {
  if (candidate.lastActivityTs === null || candidate.lastActivityTs <= 0) return null;
  return (now.getTime() - candidate.lastActivityTs * 1000) / 3_600_000;
}

export function classifyTrader(
  candidate: TraderSyncCandidate,
  now: Date,
  thresholds: ClassifyThresholds = DEFAULT_CLASSIFY_THRESHOLDS,
): SyncTier {
  if (candidate.lastSyncedAt === null) return "NEW";

  const idleHours = hoursSinceActivity(candidate, now);

  // A wallet with no ingested activity at all, that we HAVE synced, genuinely has nothing to show
  // for the request. Treat it as dormant rather than repeatedly paying for an empty answer.
  if (idleHours === null) return "DORMANT";
  if (idleHours > thresholds.dormantActivityHours) return "DORMANT";

  // A failed sync backs off to a day rather than to four. `syncError` records only the LAST
  // attempt and is cleared on success, so a transient network blip should not freeze a strong
  // wallet out for most of a week.
  if (candidate.hasSyncError) return "COLD";

  const score = candidate.smartScore ?? 0;

  if (score >= thresholds.hotScore && idleHours <= thresholds.hotActivityHours) return "HOT";
  if (idleHours <= thresholds.warmActivityHours || score >= thresholds.warmScore) return "WARM";
  return "COLD";
}

/** True when enough time has passed since the last sync for this wallet's tier. */
export function isDue(
  candidate: TraderSyncCandidate,
  tier: SyncTier,
  now: Date,
  policy: Record<SyncTier, TierPolicy> = DEFAULT_TIER_POLICY,
): boolean {
  if (candidate.lastSyncedAt === null) return true;
  const elapsed = hoursSince(candidate.lastSyncedAt, now);
  if (elapsed === null) return true;
  return elapsed >= policy[tier].refreshHours;
}

export interface SelectionOptions {
  /** How many wallets this pass may sync. */
  budget: number;
  now: Date;
  /**
   * Share of the budget held for never-synced wallets, 0..1.
   *
   * A guaranteed floor, and a ceiling only while known wallets are competing for the slots.
   * See the module header for why both behaviours are needed.
   */
  newTraderReservation?: number;
  policy?: Record<SyncTier, TierPolicy>;
  thresholds?: ClassifyThresholds;
}

export interface SelectionResult {
  selected: TraderSyncCandidate[];
  /** Tier of each selected wallet, keyed by trader id. */
  tierById: Map<string, SyncTier>;
  /** How many wallets were eligible but did not fit in the budget. */
  deferred: number;
  /** How many were not due for a refresh yet. */
  notDue: number;
  /** Count of SELECTED wallets per tier, for sync stats. */
  byTier: Record<SyncTier, number>;
}

const ALL_TIERS: SyncTier[] = ["NEW", "HOT", "WARM", "COLD", "DORMANT"];

export function selectTradersToSync(
  candidates: TraderSyncCandidate[],
  options: SelectionOptions,
): SelectionResult {
  const {
    budget,
    now,
    newTraderReservation = 0.25,
    policy = DEFAULT_TIER_POLICY,
    thresholds = DEFAULT_CLASSIFY_THRESHOLDS,
  } = options;

  const byTier = Object.fromEntries(ALL_TIERS.map((t) => [t, 0])) as Record<SyncTier, number>;
  const tierById = new Map<string, SyncTier>();

  if (budget <= 0 || candidates.length === 0) {
    return { selected: [], tierById, deferred: 0, notDue: 0, byTier };
  }

  const due: Array<{ candidate: TraderSyncCandidate; tier: SyncTier }> = [];
  let notDue = 0;

  for (const candidate of candidates) {
    const tier = classifyTrader(candidate, now, thresholds);
    if (isDue(candidate, tier, now, policy)) due.push({ candidate, tier });
    else notDue++;
  }

  // Oldest sync first within a tier, so the budget rotates through rather than re-reading the
  // same wallets every pass.
  const byStaleness = (
    a: { candidate: TraderSyncCandidate; tier: SyncTier },
    b: { candidate: TraderSyncCandidate; tier: SyncTier },
  ) => {
    const aTime = a.candidate.lastSyncedAt?.getTime() ?? 0;
    const bTime = b.candidate.lastSyncedAt?.getTime() ?? 0;
    return aTime - bTime;
  };

  const fresh = due.filter((d) => d.tier === "NEW").sort(byStaleness);
  const known = due
    .filter((d) => d.tier !== "NEW")
    .sort((a, b) => policy[a.tier].priority - policy[b.tier].priority || byStaleness(a, b));

  const reservation = Math.min(1, Math.max(0, newTraderReservation));
  const freshSlots = Math.min(fresh.length, Math.ceil(budget * reservation));

  const selectedEntries = [
    ...fresh.slice(0, freshSlots),
    // Whatever the new wallets did not use goes back to the known ones rather than idling.
    ...known.slice(0, budget - freshSlots),
  ];

  // If the known pool came up short, let extra new wallets use the remainder.
  if (selectedEntries.length < budget && fresh.length > freshSlots) {
    selectedEntries.push(...fresh.slice(freshSlots, freshSlots + (budget - selectedEntries.length)));
  }

  for (const entry of selectedEntries) {
    tierById.set(entry.candidate.id, entry.tier);
    byTier[entry.tier]++;
  }

  return {
    selected: selectedEntries.map((e) => e.candidate),
    tierById,
    deferred: Math.max(0, due.length - selectedEntries.length),
    notDue,
    byTier,
  };
}

/**
 * How deep a history to pull for a wallet, by tier.
 *
 * A never-synced wallet needs a real history before its track record means anything — a Smart
 * Trader Score computed from thirty closed positions is mostly noise. A wallet synced an hour ago
 * needs only what happened since. Spending the deep pull on every wallet every pass is the other
 * half of why the watchlist could not grow.
 */
export function historyDepthFor(tier: SyncTier, isFirstSync: boolean): {
  closedPositions: number;
  activityItems: number;
} {
  if (isFirstSync || tier === "NEW") return { closedPositions: 1000, activityItems: 3000 };
  if (tier === "HOT") return { closedPositions: 300, activityItems: 1000 };
  if (tier === "WARM") return { closedPositions: 150, activityItems: 600 };
  return { closedPositions: 100, activityItems: 300 };
}
