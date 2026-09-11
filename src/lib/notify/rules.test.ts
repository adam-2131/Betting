import { describe, expect, it } from "vitest";
import { asciiOnly, channelFor } from "./channel";
import {
  clvAlert,
  DEFAULT_THRESHOLDS,
  opportunityAlerts,
  qualifies,
  settlementAlerts,
  staleSyncAlert,
  type AlertCandidate,
} from "./rules";

const NOW = new Date("2026-09-11T12:00:00Z");
const BASE = "http://localhost:3000";

function hoursFromNow(hours: number): Date {
  return new Date(NOW.getTime() + hours * 3_600_000);
}

/** A candidate that clears every bar. Each test breaks exactly one thing. */
function candidate(overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    opportunityId: "opp1",
    question: "Bears vs. Panthers",
    outcomeLabel: "Panthers",
    action: "Bet Panthers to win",
    horizonScore: 79,
    netEdgePoints: 11,
    winProbability: 0.52,
    effectivePrice: 0.4,
    liquidity: 206_877,
    qualifiedTraders: 2,
    settlesAt: hoursFromNow(30),
    gameStartTime: hoursFromNow(27),
    ...overrides,
  };
}

describe("qualifies — every condition must hold, it is not a score", () => {
  it("accepts a candidate that clears every bar", () => {
    expect(qualifies(candidate(), NOW)).toBe(true);
  });

  it("rejects a longshot however good its other numbers", () => {
    // THE RULE THAT MATTERS MOST. Longshots carry the highest return-per-day figures on the board
    // and are the worst thing to push at someone: a 12% shot returns nothing eleven times in
    // twelve, and nobody acting on alerts is running the sample that makes the average appear.
    const longshot = candidate({
      winProbability: 0.12,
      effectivePrice: 0.08,
      netEdgePoints: 40,
      horizonScore: 95,
    });
    expect(qualifies(longshot, NOW)).toBe(false);
  });

  it("rejects an edge that does not survive the spread", () => {
    expect(qualifies(candidate({ netEdgePoints: -0.5 }), NOW)).toBe(false);
    expect(qualifies(candidate({ netEdgePoints: 1 }), NOW)).toBe(false);
  });

  it("rejects anything settling outside the window", () => {
    expect(qualifies(candidate({ settlesAt: hoursFromNow(24 * 30) }), NOW)).toBe(false);
    // Already past.
    expect(qualifies(candidate({ settlesAt: hoursFromNow(-1) }), NOW)).toBe(false);
    expect(qualifies(candidate({ settlesAt: null }), NOW)).toBe(false);
  });

  it("rejects a thin book", () => {
    expect(qualifies(candidate({ liquidity: 300 }), NOW)).toBe(false);
  });

  it("rejects a signal resting on one trader", () => {
    expect(qualifies(candidate({ qualifiedTraders: 1 }), NOW)).toBe(false);
  });

  it("rejects a low score even when the edge looks large", () => {
    expect(qualifies(candidate({ horizonScore: 20 }), NOW)).toBe(false);
  });

  it("rejects an untradeable price", () => {
    expect(qualifies(candidate({ effectivePrice: 0 }), NOW)).toBe(false);
    expect(qualifies(candidate({ effectivePrice: 1 }), NOW)).toBe(false);
    expect(qualifies(candidate({ effectivePrice: null }), NOW)).toBe(false);
  });

  it("rejects missing data rather than treating it as passing", () => {
    expect(qualifies(candidate({ winProbability: null }), NOW)).toBe(false);
    expect(qualifies(candidate({ horizonScore: null }), NOW)).toBe(false);
    expect(qualifies(candidate({ liquidity: null }), NOW)).toBe(false);
  });
});

describe("opportunityAlerts", () => {
  it("stays quiet when nothing qualifies", () => {
    expect(opportunityAlerts([candidate({ winProbability: 0.1 })], NOW, BASE)).toEqual([]);
  });

  it("says what to bet and what a dollar does", () => {
    const [alert] = opportunityAlerts([candidate()], NOW, BASE);
    expect(alert.body).toContain("Bet Panthers to win");
    expect(alert.body).toContain("$1 returns $2.50");
    expect(alert.body).toContain("loses 48% of the time");
    expect(alert.url).toBe(`${BASE}/opportunities/opp1`);
  });

  it("raises priority and changes wording when the game is about to start", () => {
    const [alert] = opportunityAlerts(
      [candidate({ gameStartTime: hoursFromNow(2), settlesAt: hoursFromNow(5) })],
      NOW,
      BASE,
    );
    expect(alert.kind).toBe("KICKOFF_SOON");
    expect(alert.priority).toBe("high");
    expect(alert.title).toContain("Starts in 2h");
  });

  it("dedupes the same position within a day but allows it again tomorrow", () => {
    const [today] = opportunityAlerts([candidate()], NOW, BASE);
    const [tomorrow] = opportunityAlerts(
      [candidate()],
      new Date("2026-09-12T12:00:00Z"),
      BASE,
    );
    expect(today.dedupeKey).not.toBe(tomorrow.dedupeKey);
    const [again] = opportunityAlerts([candidate()], new Date("2026-09-11T18:00:00Z"), BASE);
    expect(again.dedupeKey).toBe(today.dedupeKey);
  });

  it("always tells the reader the price may be stale", () => {
    const [alert] = opportunityAlerts([candidate()], NOW, BASE);
    expect(alert.body).toContain("Check it against the live market");
  });
});

describe("settlementAlerts", () => {
  it("reports a win with the amount returned", () => {
    const [alert] = settlementAlerts(
      [{ betId: "b1", outcomeLabel: "Panthers", question: "Bears vs. Panthers", won: true, pnl: 1.5, stake: 1 }],
      BASE,
    );
    expect(alert.title).toContain("Won $1.50");
    expect(alert.body).toContain("returned $2.50");
    expect(alert.dedupeKey).toBe("settled:b1");
  });

  it("reports a loss plainly", () => {
    const [alert] = settlementAlerts(
      [{ betId: "b2", outcomeLabel: "Bears", question: "Bears vs. Panthers", won: false, pnl: -1, stake: 1 }],
      BASE,
    );
    expect(alert.title).toContain("Lost $1.00");
    expect(alert.priority).toBe("low");
  });
});

describe("clvAlert", () => {
  it("stays silent while the record is inconclusive", () => {
    expect(clvAlert({ verdict: "INCONCLUSIVE", count: 12, meanPoints: 1.1 }, BASE)).toBeNull();
    expect(clvAlert({ verdict: "TOO_FEW", count: 2, meanPoints: null }, BASE)).toBeNull();
  });

  it("pushes the negative verdict hard, because it is the one that should stop you", () => {
    const alert = clvAlert({ verdict: "PAYING_UP", count: 22, meanPoints: -2.4 }, BASE);
    expect(alert?.priority).toBe("high");
    expect(alert?.body).toContain("stop");
  });

  it("does not call positive CLV profit", () => {
    const alert = clvAlert({ verdict: "BEATING_THE_CLOSE", count: 22, meanPoints: 2.4 }, BASE);
    expect(alert?.body).toContain("not profit");
  });

  it("fires once per verdict rather than once per pass", () => {
    const a = clvAlert({ verdict: "PAYING_UP", count: 22, meanPoints: -2.4 }, BASE);
    const b = clvAlert({ verdict: "PAYING_UP", count: 23, meanPoints: -2.5 }, BASE);
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
  });
});

describe("staleSyncAlert", () => {
  it("stays quiet while syncs are current", () => {
    expect(staleSyncAlert(hoursFromNow(-1), NOW, BASE)).toBeNull();
  });

  it("warns once the data is old enough to be misleading", () => {
    const alert = staleSyncAlert(hoursFromNow(-5), NOW, BASE);
    expect(alert?.title).toContain("5h old");
    expect(alert?.priority).toBe("high");
    expect(alert?.body).toContain("Do not bet");
  });

  it("nags hourly during an outage rather than every pass", () => {
    const a = staleSyncAlert(hoursFromNow(-5), new Date("2026-09-11T12:10:00Z"), BASE);
    const b = staleSyncAlert(hoursFromNow(-5), new Date("2026-09-11T12:50:00Z"), BASE);
    const c = staleSyncAlert(hoursFromNow(-5), new Date("2026-09-11T13:10:00Z"), BASE);
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
    expect(a?.dedupeKey).not.toBe(c?.dedupeKey);
  });

  it("says nothing when no sync has ever run, rather than crying stale", () => {
    expect(staleSyncAlert(null, NOW, BASE)).toBeNull();
  });

  it("uses the configured threshold", () => {
    const strict = { ...DEFAULT_THRESHOLDS, staleSyncHours: 12 };
    expect(staleSyncAlert(hoursFromNow(-5), NOW, BASE, strict)).toBeNull();
  });
});

describe("channel detection", () => {
  it("recognises a Discord webhook", () => {
    expect(channelFor("https://discord.com/api/webhooks/123/abc")).toBe("DISCORD");
    expect(channelFor("https://discordapp.com/api/webhooks/123/abc")).toBe("DISCORD");
  });

  it("recognises ntfy", () => {
    expect(channelFor("https://ntfy.sh/my-secret-topic")).toBe("NTFY");
  });

  it("treats an unconfigured channel as none", () => {
    expect(channelFor(undefined)).toBe("NONE");
    expect(channelFor("")).toBe("NONE");
    expect(channelFor("   ")).toBe("NONE");
  });

  it("falls back to plain text for an unrecognised receiver", () => {
    expect(channelFor("https://example.com/hook")).toBe("NTFY");
  });
});

describe("asciiOnly", () => {
  it("keeps accented names readable rather than dropping the letter", () => {
    // ntfy sends the title as an HTTP header, and a non-latin-1 byte makes fetch throw before the
    // request is even sent. Market questions are full of these.
    expect(asciiOnly("Vissel Kōbe vs. Kashima Antlers")).toBe("Vissel Kobe vs. Kashima Antlers");
    expect(asciiOnly("Kylian Mbappé")).toBe("Kylian Mbappe");
  });

  it("strips symbols that cannot be encoded", () => {
    expect(asciiOnly("Bills → Texans")).toBe("Bills  Texans");
    expect(asciiOnly("price 15¢")).toBe("price 15");
  });
});
