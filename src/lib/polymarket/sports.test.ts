import { describe, expect, it } from "vitest";
import {
  classifySportsMarket,
  estimatedSettlementAt,
  gameDurationHours,
  isTradeableSportsMarket,
  leagueFromTags,
  parseGameStartTime,
  SPORTS_TRADEABILITY,
} from "./sports";

/**
 * Every literal in this file — timestamps, liquidity, spreads, market-type strings — is verbatim
 * from a live `/events?tag_slug=nfl` response captured while writing this module.
 */
describe("parseGameStartTime", () => {
  it("parses the exact format Polymarket sends", () => {
    // Bills vs. Texans, verbatim.
    expect(parseGameStartTime("2026-09-13 17:00:00+00")?.toISOString()).toBe(
      "2026-09-13T17:00:00.000Z",
    );
  });

  it("treats a missing offset as UTC rather than host-local time", () => {
    // THE REGRESSION THIS MODULE EXISTS FOR. `new Date("2026-09-13 17:00:00")` is host-local, so
    // on a UTC+2 machine it silently yields 15:00Z and every hours-to-kickoff figure is two hours
    // wrong. Must be read as UTC regardless of where this runs.
    expect(parseGameStartTime("2026-09-13 17:00:00")?.toISOString()).toBe(
      "2026-09-13T17:00:00.000Z",
    );
  });

  it("accepts already-compliant ISO forms unchanged", () => {
    expect(parseGameStartTime("2026-09-13T17:00:00Z")?.toISOString()).toBe(
      "2026-09-13T17:00:00.000Z",
    );
    expect(parseGameStartTime("2026-09-13 17:00:00+00:00")?.toISOString()).toBe(
      "2026-09-13T17:00:00.000Z",
    );
  });

  it("honours a real non-zero offset instead of forcing UTC", () => {
    expect(parseGameStartTime("2026-09-13 17:00:00-05")?.toISOString()).toBe(
      "2026-09-13T22:00:00.000Z",
    );
  });

  it("returns null for absent or unparseable input rather than an Invalid Date", () => {
    expect(parseGameStartTime(null)).toBeNull();
    expect(parseGameStartTime(undefined)).toBeNull();
    expect(parseGameStartTime("")).toBeNull();
    expect(parseGameStartTime("   ")).toBeNull();
    expect(parseGameStartTime("not a date")).toBeNull();
  });
});

describe("classifySportsMarket", () => {
  it("puts the three markets that carry real liquidity in CORE", () => {
    expect(classifySportsMarket("moneyline").tier).toBe("CORE");
    expect(classifySportsMarket("spreads").tier).toBe("CORE");
    expect(classifySportsMarket("totals").tier).toBe("CORE");
  });

  it("puts quarter and prop markets in EXOTIC", () => {
    expect(classifySportsMarket("q2_moneyline").tier).toBe("EXOTIC");
    expect(classifySportsMarket("exact_margin").tier).toBe("EXOTIC");
    expect(classifySportsMarket("longest_field_goal").tier).toBe("EXOTIC");
  });

  it("defaults an unrecognised type to EXOTIC and humanises its label", () => {
    // New auto-generated prop types keep appearing; they must not default into CORE.
    const kind = classifySportsMarket("player_rushing_yards");
    expect(kind.tier).toBe("EXOTIC");
    expect(kind.label).toBe("Player rushing yards");
  });

  it("treats a missing type as EXOTIC", () => {
    expect(classifySportsMarket(null).tier).toBe("EXOTIC");
    expect(classifySportsMarket(undefined).tier).toBe("EXOTIC");
  });
});

describe("isTradeableSportsMarket", () => {
  it("accepts the real moneyline book", () => {
    // Bills vs. Texans moneyline, verbatim.
    expect(isTradeableSportsMarket({ liquidity: 208_268.0058, spread: 0.01 }).tradeable).toBe(true);
  });

  it("rejects the unquoted placeholder books that dominate a sports slate", () => {
    // q2_moneyline and second_half_totals, verbatim. Both sit at 50/50 with a ~96¢ spread.
    const q2 = isTradeableSportsMarket({ liquidity: 2.36, spread: 0.96 });
    expect(q2.tradeable).toBe(false);
    expect(q2.reason).toContain("96¢ spread");

    expect(isTradeableSportsMarket({ liquidity: 1.08, spread: 0.99 }).tradeable).toBe(false);
  });

  it("rejects a tight spread that still has no depth behind it", () => {
    expect(
      isTradeableSportsMarket({ liquidity: SPORTS_TRADEABILITY.minLiquidityUsd - 1, spread: 0.01 })
        .tradeable,
    ).toBe(false);
  });

  it("refuses rather than assumes when nothing is reported", () => {
    expect(isTradeableSportsMarket({ liquidity: null, spread: null }).tradeable).toBe(false);
  });

  it("accepts the 1st-half books, which are genuinely quoted", () => {
    // first_half_spreads and first_half_moneyline, verbatim.
    expect(isTradeableSportsMarket({ liquidity: 4276.8328, spread: 0.02 }).tradeable).toBe(true);
    expect(isTradeableSportsMarket({ liquidity: 3460.9121, spread: 0.02 }).tradeable).toBe(true);
  });
});

describe("league and settlement estimation", () => {
  it("finds the league in a real tag list", () => {
    expect(leagueFromTags(["sports", "nfl", "bills"])).toBe("nfl");
    expect(leagueFromTags(["ucl", "soccer", "sports", "champions-league"])).toBe("ucl");
  });

  it("returns null when no tag names a league we know", () => {
    expect(leagueFromTags(["sports", "caitlin-clark"])).toBeNull();
    expect(leagueFromTags([])).toBeNull();
  });

  it("prefers the specific competition over the umbrella tag", () => {
    // Verbatim tag set from a live esports market. `esports` comes first in the list and is also
    // a known league, so a first-match scan would take its 2.5h instead of LoL's 3h.
    expect(leagueFromTags(["esports", "games", "sports", "league-of-legends"])).toBe(
      "league-of-legends",
    );
    expect(leagueFromTags(["esports", "games", "sports", "counter-strike-2"])).toBe(
      "counter-strike-2",
    );
    expect(leagueFromTags(["soccer", "sports", "epl"])).toBe("epl");
  });

  it("falls back to the umbrella tag when no specific league is present", () => {
    expect(leagueFromTags(["esports", "games", "sports"])).toBe("esports");
  });

  it("falls back to a mid-range duration for an unknown league", () => {
    expect(gameDurationHours("nfl")).toBe(3.2);
    expect(gameDurationHours("kabaddi")).toBe(3);
    expect(gameDurationHours(null)).toBe(3);
  });

  it("estimates settlement as kickoff plus the game length, not at kickoff", () => {
    // endDate equals gameStartTime on a game market, so treating endDate as settlement would
    // understate the hold by the entire length of the game.
    const kickoff = new Date("2026-09-13T17:00:00Z");
    expect(estimatedSettlementAt(kickoff, "nfl")?.toISOString()).toBe("2026-09-13T20:12:00.000Z");
    expect(estimatedSettlementAt(kickoff, "epl")?.toISOString()).toBe("2026-09-13T19:00:00.000Z");
  });

  it("returns null without a kickoff time instead of guessing", () => {
    expect(estimatedSettlementAt(null, "nfl")).toBeNull();
  });
});
