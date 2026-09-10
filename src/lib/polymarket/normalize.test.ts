import { describe, expect, it } from "vitest";
import {
  isValidWallet,
  normalizeClosedPosition,
  normalizeWallet,
  parseJsonArray,
  parseNumberArray,
  parseUnixSeconds,
  polymarketMarketUrl,
  resolveOutcomeIndex,
  settlementToWon,
} from "./normalize";
import type { DataClosedPosition } from "./types";

describe("parseJsonArray — Polymarket's JSON-encoded string arrays", () => {
  it("parses the outcomes / outcomePrices / clobTokenIds string form", () => {
    expect(parseJsonArray('["Yes", "No"]')).toEqual(["Yes", "No"]);
    expect(parseJsonArray('["0.0015", "0.9985"]')).toEqual(["0.0015", "0.9985"]);
  });

  it("tolerates an already-parsed array", () => {
    expect(parseJsonArray(["Yes", "No"])).toEqual(["Yes", "No"]);
  });

  it("returns an empty array rather than throwing on junk", () => {
    expect(parseJsonArray("not json")).toEqual([]);
    expect(parseJsonArray("")).toEqual([]);
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray(undefined)).toEqual([]);
    expect(parseJsonArray('{"a":1}')).toEqual([]);
  });

  it("converts price strings to numbers and drops unparseable entries", () => {
    expect(parseNumberArray('["0.25", "0.75"]')).toEqual([0.25, 0.75]);
    expect(parseNumberArray('["0.25", "abc"]')).toEqual([0.25]);
  });
});

describe("resolveOutcomeIndex", () => {
  it("reads resolution from settled outcome prices", () => {
    expect(resolveOutcomeIndex([1, 0], true)).toBe(0);
    expect(resolveOutcomeIndex([0, 1], true)).toBe(1);
  });

  it("returns null for an open market even at extreme prices", () => {
    expect(resolveOutcomeIndex([0.99, 0.01], false)).toBeNull();
    expect(resolveOutcomeIndex([1, 0], false)).toBeNull();
  });

  it("returns null when settlement is ambiguous rather than guessing a winner", () => {
    expect(resolveOutcomeIndex([0.5, 0.5], true)).toBeNull();
    expect(resolveOutcomeIndex([1, 1], true)).toBeNull();
    expect(resolveOutcomeIndex([], true)).toBeNull();
  });
});

describe("settlementToWon", () => {
  it("maps a clean settlement to win or loss", () => {
    expect(settlementToWon(1)).toBe(true);
    expect(settlementToWon(0)).toBe(false);
  });

  it("returns null for anything in between so it is excluded from win rate", () => {
    expect(settlementToWon(0.5)).toBeNull();
    expect(settlementToWon(0.925)).toBeNull();
    expect(settlementToWon(null)).toBeNull();
  });
});

describe("normalizeClosedPosition — cost basis", () => {
  /**
   * `totalBought` is SHARES, not dollars, despite the name. Verified against 50/50 live rows:
   * for a winner, realizedPnl == totalBought − totalBought × avgPrice.
   */
  function row(overrides: Partial<DataClosedPosition> = {}): DataClosedPosition {
    return {
      proxyWallet: "0xABC0000000000000000000000000000000000001",
      asset: "token-1",
      conditionId: "0xcond",
      avgPrice: 0.5561,
      totalBought: 149999.8872,
      realizedPnl: 66570.5499,
      curPrice: 1,
      title: "Will AA Argentinos Juniors win?",
      outcome: "Yes",
      outcomeIndex: 0,
      timestamp: 1782948821,
      ...overrides,
    };
  }

  it("derives USD cost basis as shares × avgPrice", () => {
    const result = normalizeClosedPosition(row())!;
    expect(result.sharesBought).toBeCloseTo(149999.8872, 4);
    expect(result.costBasisUsd).toBeCloseTo(149999.8872 * 0.5561, 6);
  });

  it("reproduces the API's realizedPnl far better than the dollars reading does", () => {
    // The discriminating test. `avgPrice` is rounded to 4dp upstream and entry fees are not
    // reflected, so neither reading is exact — but the shares reading lands within a fraction of
    // a percent while the dollars reading is out by an order of magnitude.
    const result = normalizeClosedPosition(row())!;
    const reported = result.realizedPnl as number;

    const sharesReading = (result.sharesBought as number) - (result.costBasisUsd as number);
    const dollarsReading = 149999.8872 / 0.5561 - 149999.8872;

    const sharesError = Math.abs(sharesReading - reported) / Math.abs(reported);
    const dollarsError = Math.abs(dollarsReading - reported) / Math.abs(reported);

    expect(sharesError).toBeLessThan(0.005);
    expect(dollarsError).toBeGreaterThan(0.5);
  });

  it("reproduces a loser's realizedPnl as the negative of the cost basis", () => {
    const loser = normalizeClosedPosition(
      row({ avgPrice: 0.1, totalBought: 50000, realizedPnl: -5000, curPrice: 0 }),
    )!;
    expect(loser.costBasisUsd).toBeCloseTo(5000, 6);
    expect(loser.realizedPnl).toBeCloseTo(-(loser.costBasisUsd as number), 6);
    expect(loser.won).toBe(false);
  });

  it("returns a null cost basis rather than 0 when the price is missing", () => {
    expect(normalizeClosedPosition(row({ avgPrice: undefined }))!.costBasisUsd).toBeNull();
    expect(normalizeClosedPosition(row({ avgPrice: 0 }))!.costBasisUsd).toBeNull();
  });

  it("lowercases the wallet and converts the unix timestamp", () => {
    const result = normalizeClosedPosition(row())!;
    expect(result.wallet).toBe("0xabc0000000000000000000000000000000000001");
    expect(result.resolvedAt?.toISOString()).toBe(new Date(1782948821 * 1000).toISOString());
  });
});

describe("parseUnixSeconds", () => {
  it("rejects the API's 0 sentinel", () => {
    expect(parseUnixSeconds(0)).toBeNull();
    expect(parseUnixSeconds(-1)).toBeNull();
    expect(parseUnixSeconds(null)).toBeNull();
  });
});

describe("wallet validation", () => {
  it("accepts a well-formed Ethereum address in any case", () => {
    expect(isValidWallet("0x2c335066fe58fe9237c3d3dc7b275c2a034a0563")).toBe(true);
    expect(isValidWallet("0x2C335066FE58FE9237C3D3DC7B275C2A034A0563")).toBe(true);
    expect(isValidWallet("  0x2c335066fe58fe9237c3d3dc7b275c2a034a0563  ")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isValidWallet("0x123")).toBe(false);
    expect(isValidWallet("2c335066fe58fe9237c3d3dc7b275c2a034a0563")).toBe(false);
    expect(isValidWallet("0xZZ335066fe58fe9237c3d3dc7b275c2a034a0563")).toBe(false);
    expect(isValidWallet("")).toBe(false);
  });

  it("normalizes to lowercase so a wallet cannot be tracked twice", () => {
    expect(normalizeWallet("  0xABCdef0000000000000000000000000000000001 ")).toBe(
      "0xabcdef0000000000000000000000000000000001",
    );
  });
});

describe("polymarketMarketUrl", () => {
  it("prefers the event slug and always returns a usable link", () => {
    expect(polymarketMarketUrl("m", "e")).toBe("https://polymarket.com/event/e");
    expect(polymarketMarketUrl("m", null)).toBe("https://polymarket.com/market/m");
    expect(polymarketMarketUrl(null, null)).toBe("https://polymarket.com");
  });
});
