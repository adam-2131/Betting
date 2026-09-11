import { describe, expect, it } from "vitest";
import { analyzeSportsAngle, type SportsAngleInput } from "./sports";

const NOW = new Date("2026-09-11T12:00:00Z");
/** Bills vs. Texans kickoff, verbatim from the live NFL slate. */
const KICKOFF = new Date("2026-09-13T17:00:00Z");

function input(overrides: Partial<SportsAngleInput> = {}): SportsAngleInput {
  return {
    gameStartTime: KICKOFF,
    league: "nfl",
    sportsMarketType: "moneyline",
    liquidity: 208_268,
    spread: 0.01,
    currentPrice: 0.525,
    weightedEntryPrice: 0.5,
    increasingCount: 2,
    decreasingCount: 0,
    entries: [],
    now: NOW,
    ...overrides,
  };
}

describe("game versus season future", () => {
  it("treats a market with a kickoff time as a game", () => {
    const angle = analyzeSportsAngle(input());
    expect(angle.isGame).toBe(true);
    expect(angle.phase).toBe("APPROACHING");
  });

  it("treats a market with no kickoff time as a season future, not a game", () => {
    // "Pro Football: 2027 Champion" is tagged nfl and has an endDate, but no gameStartTime.
    const angle = analyzeSportsAngle(input({ gameStartTime: null }));
    expect(angle.isGame).toBe(false);
    expect(angle.phase).toBe("NOT_A_GAME");
    expect(angle.settlesAt).toBeNull();
    expect(angle.notes.join(" ")).toContain("season-long");
  });

  it("estimates settlement as kickoff plus the game length, not at kickoff", () => {
    const angle = analyzeSportsAngle(input());
    expect(angle.settlesAt?.toISOString()).toBe("2026-09-13T20:12:00.000Z");
  });
});

describe("game phase", () => {
  it("calls a game days out EARLY", () => {
    const angle = analyzeSportsAngle(
      input({ gameStartTime: new Date("2026-09-25T17:00:00Z") }),
    );
    expect(angle.phase).toBe("EARLY");
    expect(angle.notes.join(" ")).toContain("days away");
  });

  it("calls a game hours out IMMINENT and says the line is at its sharpest", () => {
    const angle = analyzeSportsAngle(
      input({ gameStartTime: new Date("2026-09-11T15:00:00Z") }),
    );
    expect(angle.phase).toBe("IMMINENT");
    expect(angle.notes.join(" ")).toContain("sharpest");
  });

  it("warns that a game past kickoff is being played live", () => {
    // Polymarket keeps trading through the game, and this app has no live score feed.
    const angle = analyzeSportsAngle(
      input({ gameStartTime: new Date("2026-09-11T11:00:00Z") }),
    );
    expect(angle.phase).toBe("IN_PLAY");
    expect(angle.warnings.join(" ")).toContain("underway");
  });

  it("marks a game past its estimated finish as ENDED", () => {
    // NFL runs 3.2h, so four hours after kickoff the result is in.
    const angle = analyzeSportsAngle(
      input({ gameStartTime: new Date("2026-09-11T08:00:00Z") }),
    );
    expect(angle.phase).toBe("ENDED");
    expect(angle.warnings.join(" ")).toContain("already decided");
  });

  it("uses the league's own game length to decide when in-play ends", () => {
    // A soccer match runs 2h, so 2.5 hours after kickoff it is over while an NFL game is not.
    const started = new Date("2026-09-11T09:30:00Z");
    expect(analyzeSportsAngle(input({ gameStartTime: started, league: "epl" })).phase).toBe("ENDED");
    expect(analyzeSportsAngle(input({ gameStartTime: started, league: "nfl" })).phase).toBe(
      "IN_PLAY",
    );
  });
});

describe("tradeability gate", () => {
  it("accepts the real moneyline book", () => {
    expect(analyzeSportsAngle(input()).tradeable.tradeable).toBe(true);
  });

  it("rejects and explains an unquoted placeholder book", () => {
    // q2_moneyline, verbatim: $2.36 of liquidity behind a 96¢ spread.
    const angle = analyzeSportsAngle(
      input({ sportsMarketType: "q2_moneyline", liquidity: 2.36, spread: 0.96 }),
    );
    expect(angle.tradeable.tradeable).toBe(false);
    expect(angle.warnings.join(" ")).toContain("auto-generates");
  });

  it("notes when a quoted market is still not a main line", () => {
    const angle = analyzeSportsAngle(
      input({ sportsMarketType: "q1_spreads", liquidity: 3413, spread: 0.04 }),
    );
    expect(angle.tradeable.tradeable).toBe(true);
    expect(angle.notes.join(" ")).toContain("main line");
  });
});

describe("late money", () => {
  const kickoff = KICKOFF;
  const lateBuy = new Date("2026-09-13T09:00:00Z"); // 8h before kickoff
  const earlyBuy = new Date("2026-09-05T09:00:00Z"); // 8 days before

  it("splits tracked buys by how close to kickoff they landed", () => {
    const angle = analyzeSportsAngle(
      input({
        entries: [
          { usd: 8000, at: lateBuy },
          { usd: 2000, at: earlyBuy },
        ],
      }),
    );

    expect(angle.lateMoneyUsd).toBe(8000);
    expect(angle.earlyMoneyUsd).toBe(2000);
    expect(angle.lateMoneyShare).toBeCloseTo(0.8, 10);
    expect(angle.notes.join(" ")).toContain("within 24 hours of kickoff");
  });

  it("calls out a position built entirely before the news landed", () => {
    const angle = analyzeSportsAngle(
      input({ entries: [{ usd: 10_000, at: earlyBuy }] }),
    );
    expect(angle.lateMoneyShare).toBe(0);
    expect(angle.notes.join(" ")).toContain("without the late news");
  });

  it("counts an in-play buy as late", () => {
    const angle = analyzeSportsAngle(
      input({ entries: [{ usd: 500, at: new Date(kickoff.getTime() + HOUR) }] }),
    );
    expect(angle.lateMoneyUsd).toBe(500);
  });

  it("excludes undated buys from both buckets rather than assuming they were early", () => {
    // Position open times come from an incrementally-fetched activity log, so a missing timestamp
    // means "not ingested yet". Defaulting it to early would libel every newly-tracked wallet.
    const angle = analyzeSportsAngle(
      input({
        entries: [
          { usd: 1000, at: lateBuy },
          { usd: 9000, at: null },
        ],
      }),
    );
    expect(angle.lateMoneyUsd).toBe(1000);
    expect(angle.earlyMoneyUsd).toBe(0);
    expect(angle.lateMoneyShare).toBe(1);
  });

  it("reports no share at all when nothing is dated", () => {
    const angle = analyzeSportsAngle(input({ entries: [{ usd: 9000, at: null }] }));
    expect(angle.lateMoneyShare).toBeNull();
  });

  it("has no late-money view of a season future", () => {
    const angle = analyzeSportsAngle(
      input({ gameStartTime: null, entries: [{ usd: 1000, at: earlyBuy }] }),
    );
    expect(angle.lateMoneyShare).toBeNull();
  });
});

const HOUR = 3_600_000;

describe("line movement read together with flow", () => {
  it("calls a favourable move with continued buying STEAM", () => {
    const angle = analyzeSportsAngle(
      input({ currentPrice: 0.57, weightedEntryPrice: 0.5, increasingCount: 3, decreasingCount: 0 }),
    );
    expect(angle.lineVerdict).toBe("STEAM");
    expect(angle.lineMovePoints).toBeCloseTo(7, 6);
    expect(angle.notes.join(" ")).toContain("come round to their read");
  });

  it("calls a favourable move with no further buying CONFIRMED, and says you pay up", () => {
    const angle = analyzeSportsAngle(
      input({ currentPrice: 0.57, weightedEntryPrice: 0.5, increasingCount: 0, decreasingCount: 0 }),
    );
    expect(angle.lineVerdict).toBe("CONFIRMED");
    expect(angle.notes.join(" ")).toContain("worse price than they did");
  });

  it("calls an adverse move with continued buying DOUBLING DOWN, and notes the better entry", () => {
    const angle = analyzeSportsAngle(
      input({ currentPrice: 0.43, weightedEntryPrice: 0.5, increasingCount: 3, decreasingCount: 0 }),
    );
    expect(angle.lineVerdict).toBe("DOUBLING_DOWN");
    expect(angle.notes.join(" ")).toContain("better price than they did");
  });

  it("treats an adverse move with traders exiting as a warning, not a discount", () => {
    // The distinction the entry-gap analysis alone cannot make: this looks like a cheap entry and
    // is actually the smart money leaving.
    const angle = analyzeSportsAngle(
      input({ currentPrice: 0.43, weightedEntryPrice: 0.5, increasingCount: 0, decreasingCount: 3 }),
    );
    expect(angle.lineVerdict).toBe("CAPITULATING");
    expect(angle.warnings.join(" ")).toContain("getting out");
    expect(angle.notes.join(" ")).not.toContain("getting out");
  });

  it("treats a sub-tick move as flat rather than reading meaning into noise", () => {
    const angle = analyzeSportsAngle(
      input({ currentPrice: 0.502, weightedEntryPrice: 0.5, increasingCount: 3 }),
    );
    expect(angle.lineVerdict).toBe("FLAT");
  });

  it("says UNKNOWN rather than guessing when there is no entry price", () => {
    const angle = analyzeSportsAngle(input({ weightedEntryPrice: null }));
    expect(angle.lineVerdict).toBe("UNKNOWN");
    expect(angle.lineMovePoints).toBeNull();
  });

  it("says UNKNOWN when the line moved against them and flow is balanced", () => {
    const angle = analyzeSportsAngle(
      input({ currentPrice: 0.43, weightedEntryPrice: 0.5, increasingCount: 2, decreasingCount: 2 }),
    );
    expect(angle.lineVerdict).toBe("UNKNOWN");
  });
});

describe("degenerate input", () => {
  it("never throws and never emits NaN", () => {
    const angle = analyzeSportsAngle(
      input({
        gameStartTime: null,
        league: null,
        sportsMarketType: null,
        liquidity: null,
        spread: null,
        currentPrice: null,
        weightedEntryPrice: null,
        increasingCount: 0,
        decreasingCount: 0,
        entries: [{ usd: null, at: null }],
      }),
    );

    expect(angle.lateMoneyUsd).toBe(0);
    expect(angle.lineMovePoints).toBeNull();
    expect(angle.isGame).toBe(false);
    expect(Number.isNaN(angle.lateMoneyUsd)).toBe(false);
  });
});
