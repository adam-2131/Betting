import { describe, expect, it } from "vitest";
import {
  classifyTrader,
  DEFAULT_TIER_POLICY,
  historyDepthFor,
  isDue,
  selectTradersToSync,
  type TraderSyncCandidate,
} from "./trader-selection";

const NOW = new Date("2026-09-11T12:00:00Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function tsHoursAgo(hours: number): number {
  return Math.floor(hoursAgo(hours).getTime() / 1000);
}

function candidate(overrides: Partial<TraderSyncCandidate> = {}): TraderSyncCandidate {
  return {
    id: overrides.id ?? "t1",
    wallet: overrides.wallet ?? "0xabc",
    lastSyncedAt: hoursAgo(24),
    lastActivityTs: tsHoursAgo(4),
    smartScore: 70,
    hasSyncError: false,
    ...overrides,
  };
}

describe("classifyTrader", () => {
  it("calls a never-synced wallet NEW", () => {
    expect(classifyTrader(candidate({ lastSyncedAt: null }), NOW)).toBe("NEW");
  });

  it("calls a strong, currently-trading wallet HOT", () => {
    expect(classifyTrader(candidate({ smartScore: 75, lastActivityTs: tsHoursAgo(3) }), NOW)).toBe(
      "HOT",
    );
  });

  it("does not call a strong but quiet wallet HOT", () => {
    // A high score with no recent trades will return the same positions as last pass.
    expect(
      classifyTrader(candidate({ smartScore: 90, lastActivityTs: tsHoursAgo(24 * 10) }), NOW),
    ).toBe("WARM");
  });

  it("keeps a recently-active low scorer WARM", () => {
    expect(classifyTrader(candidate({ smartScore: 10, lastActivityTs: tsHoursAgo(24) }), NOW)).toBe(
      "WARM",
    );
  });

  it("drops a long-quiet low scorer to COLD", () => {
    expect(
      classifyTrader(candidate({ smartScore: 10, lastActivityTs: tsHoursAgo(24 * 30) }), NOW),
    ).toBe("COLD");
  });

  it("calls a wallet silent for months DORMANT", () => {
    expect(classifyTrader(candidate({ lastActivityTs: tsHoursAgo(24 * 200) }), NOW)).toBe("DORMANT");
  });

  it("calls a synced wallet with no ingested activity DORMANT rather than paying for it repeatedly", () => {
    expect(classifyTrader(candidate({ lastActivityTs: null }), NOW)).toBe("DORMANT");
  });

  it("backs a failed sync off to a day, not to four", () => {
    // syncError records only the last attempt and is cleared on success, so a transient blip must
    // not freeze a strong wallet out for most of a week.
    const tier = classifyTrader(
      candidate({ hasSyncError: true, smartScore: 90, lastActivityTs: tsHoursAgo(1) }),
      NOW,
    );
    expect(tier).toBe("COLD");
    expect(DEFAULT_TIER_POLICY[tier].refreshHours).toBe(24);
  });
});

describe("isDue", () => {
  it("always syncs a wallet that has never been synced", () => {
    expect(isDue(candidate({ lastSyncedAt: null }), "NEW", NOW)).toBe(true);
  });

  it("holds a hot wallet until its interval elapses", () => {
    expect(isDue(candidate({ lastSyncedAt: hoursAgo(1) }), "HOT", NOW)).toBe(false);
    expect(isDue(candidate({ lastSyncedAt: hoursAgo(3) }), "HOT", NOW)).toBe(true);
  });

  it("holds a dormant wallet far longer than a hot one", () => {
    const fourDaysStale = candidate({ lastSyncedAt: hoursAgo(50) });
    expect(isDue(fourDaysStale, "HOT", NOW)).toBe(true);
    expect(isDue(fourDaysStale, "DORMANT", NOW)).toBe(false);
  });
});

describe("selectTradersToSync", () => {
  function pool(count: number, make: (i: number) => Partial<TraderSyncCandidate>) {
    return Array.from({ length: count }, (_, i) => candidate({ id: `t${i}`, ...make(i) }));
  }

  it("spends the budget on wallets that are actually due", () => {
    const candidates = [
      ...pool(5, (i) => ({ id: `hot${i}`, lastSyncedAt: hoursAgo(10), smartScore: 80 })),
      // Not due: hot tier refreshes every 2h and these synced 30 minutes ago.
      ...pool(5, (i) => ({ id: `fresh${i}`, lastSyncedAt: hoursAgo(0.5), smartScore: 80 })),
    ];

    const result = selectTradersToSync(candidates, { budget: 10, now: NOW });
    expect(result.selected).toHaveLength(5);
    expect(result.notDue).toBe(5);
  });

  it("reserves budget for new wallets so discovery is not starved", () => {
    // 500 hot wallets against a budget of 200 would otherwise consume every slot and newly
    // discovered wallets would never be read at all.
    const candidates = [
      ...pool(500, (i) => ({ id: `hot${i}`, lastSyncedAt: hoursAgo(10), smartScore: 80 })),
      ...pool(50, (i) => ({ id: `new${i}`, lastSyncedAt: null })),
    ];

    const result = selectTradersToSync(candidates, {
      budget: 200,
      now: NOW,
      newTraderReservation: 0.25,
    });

    expect(result.selected).toHaveLength(200);
    expect(result.byTier.NEW).toBe(50);
    expect(result.byTier.HOT).toBe(150);
  });

  it("caps new wallets at their share so they cannot starve the hot ones", () => {
    // The mirror failure: 3000 undiscovered wallets must not consume every pass and leave the
    // traders actually producing signals stale.
    const candidates = [
      ...pool(3000, (i) => ({ id: `new${i}`, lastSyncedAt: null })),
      ...pool(100, (i) => ({ id: `hot${i}`, lastSyncedAt: hoursAgo(10), smartScore: 80 })),
    ];

    const result = selectTradersToSync(candidates, {
      budget: 200,
      now: NOW,
      newTraderReservation: 0.25,
    });

    // Every hot wallet still gets synced — that is the starvation this guards against.
    expect(result.byTier.HOT).toBe(100);
    // New wallets take their reserved 50, then absorb the 50 the known pool could not fill.
    // The reservation caps them only while known wallets are competing for the slots; leaving
    // capacity idle when they are not would waste the pass.
    expect(result.byTier.NEW).toBe(100);
    expect(result.selected).toHaveLength(200);
  });

  it("gives unused new-wallet slots back to known wallets", () => {
    const candidates = [
      ...pool(100, (i) => ({ id: `hot${i}`, lastSyncedAt: hoursAgo(10), smartScore: 80 })),
      ...pool(2, (i) => ({ id: `new${i}`, lastSyncedAt: null })),
    ];

    const result = selectTradersToSync(candidates, { budget: 50, now: NOW });
    expect(result.selected).toHaveLength(50);
    expect(result.byTier.NEW).toBe(2);
    expect(result.byTier.HOT).toBe(48);
  });

  it("prefers hot over warm over cold when the budget is tight", () => {
    const candidates = [
      ...pool(10, (i) => ({ id: `cold${i}`, lastSyncedAt: hoursAgo(48), smartScore: 5, lastActivityTs: tsHoursAgo(24 * 30) })),
      ...pool(10, (i) => ({ id: `hot${i}`, lastSyncedAt: hoursAgo(48), smartScore: 80, lastActivityTs: tsHoursAgo(2) })),
    ];

    const result = selectTradersToSync(candidates, { budget: 10, now: NOW });
    expect(result.byTier.HOT).toBe(10);
    expect(result.byTier.COLD).toBe(0);
  });

  it("rotates through wallets by staleness rather than re-reading the same ones", () => {
    const candidates = [
      candidate({ id: "stale", lastSyncedAt: hoursAgo(72), smartScore: 80, lastActivityTs: tsHoursAgo(2) }),
      candidate({ id: "recent", lastSyncedAt: hoursAgo(3), smartScore: 80, lastActivityTs: tsHoursAgo(2) }),
    ];

    const result = selectTradersToSync(candidates, { budget: 1, now: NOW });
    expect(result.selected[0].id).toBe("stale");
    expect(result.deferred).toBe(1);
  });

  it("returns nothing for a zero budget instead of throwing", () => {
    const result = selectTradersToSync(pool(10, () => ({})), { budget: 0, now: NOW });
    expect(result.selected).toEqual([]);
    expect(result.deferred).toBe(0);
  });

  it("handles an empty watchlist", () => {
    const result = selectTradersToSync([], { budget: 100, now: NOW });
    expect(result.selected).toEqual([]);
  });

  it("never selects the same wallet twice", () => {
    const candidates = [
      ...pool(30, (i) => ({ id: `new${i}`, lastSyncedAt: null })),
      ...pool(30, (i) => ({ id: `hot${i}`, lastSyncedAt: hoursAgo(10), smartScore: 80 })),
    ];
    const result = selectTradersToSync(candidates, { budget: 60, now: NOW });
    expect(new Set(result.selected.map((c) => c.id)).size).toBe(result.selected.length);
  });
});

describe("historyDepthFor", () => {
  it("pulls a deep history for a wallet we know nothing about", () => {
    // A Smart Trader Score computed from thirty closed positions is mostly noise.
    expect(historyDepthFor("NEW", true).closedPositions).toBe(1000);
    expect(historyDepthFor("COLD", true).closedPositions).toBe(1000);
  });

  it("pulls only what is new for a wallet synced recently", () => {
    expect(historyDepthFor("HOT", false).closedPositions).toBeLessThan(
      historyDepthFor("NEW", true).closedPositions,
    );
    expect(historyDepthFor("DORMANT", false).activityItems).toBeLessThan(
      historyDepthFor("HOT", false).activityItems,
    );
  });
});
