import { beforeEach, describe, expect, it, vi } from "vitest";
import { Category, TraderSource } from "@prisma/client";

const findManyMarkets = vi.fn();
const findManyTraders = vi.fn();
const createMany = vi.fn();
const fetchHolders = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    market: { findMany: (...args: unknown[]) => findManyMarkets(...args) },
    trader: {
      findMany: (...args: unknown[]) => findManyTraders(...args),
      createMany: (...args: unknown[]) => createMany(...args),
    },
  },
}));

const fetchTrades = vi.fn();

vi.mock("@/lib/polymarket/data", () => ({
  fetchHolders: (...args: unknown[]) => fetchHolders(...args),
  fetchTrades: (...args: unknown[]) => fetchTrades(...args),
}));

const { discoverFromHolders, discoverFromTape } = await import("./discover");

function market(conditionId: string, category: Category = Category.SPORTS) {
  return { conditionId, category };
}

function holder(proxyWallet: string, amount = 1000, extra: Record<string, unknown> = {}) {
  return { proxyWallet, amount, ...extra };
}

describe("discoverFromHolders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyTraders.mockResolvedValue([]);
    createMany.mockResolvedValue({ count: 0 });
  });

  it("selects markets by volume, never by anything about the holders", async () => {
    findManyMarkets.mockResolvedValue([market("c1")]);
    fetchHolders.mockResolvedValue([]);

    await discoverFromHolders({ marketSample: 10 });

    // The whole point of this stage: the sample must not be conditioned on trader performance.
    const query = findManyMarkets.mock.calls[0][0];
    expect(query.orderBy).toEqual({ volume: "desc" });
    expect(JSON.stringify(query.where)).not.toContain("pnl");
    expect(JSON.stringify(query.where)).not.toContain("performance");
  });

  it("adds wallets that recur across several markets", async () => {
    findManyMarkets.mockResolvedValue([market("c1"), market("c2"), market("c3")]);
    fetchHolders.mockResolvedValue([{ token: "t", holders: [holder("0xAAA")] }]);

    const stats = await discoverFromHolders({ minMarketsHeld: 2 });

    expect(stats.added).toBe(1);
    const created = createMany.mock.calls[0][0].data;
    expect(created[0].wallet).toBe("0xaaa");
    expect(created[0].source).toBe(TraderSource.HOLDERS);
  });

  it("skips a wallet seen in only one market", async () => {
    findManyMarkets.mockResolvedValue([market("c1"), market("c2")]);
    fetchHolders.mockImplementation((conditionId: string) =>
      Promise.resolve(
        conditionId === "c1" ? [{ token: "t", holders: [holder("0xONCE")] }] : [],
      ),
    );

    const stats = await discoverFromHolders({ minMarketsHeld: 2 });

    expect(stats.belowThreshold).toBe(1);
    expect(stats.added).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("counts a market once even when a wallet holds both sides", async () => {
    findManyMarkets.mockResolvedValue([market("c1")]);
    fetchHolders.mockResolvedValue([
      { token: "yes", holders: [holder("0xBOTH", 500)] },
      { token: "no", holders: [holder("0xBOTH", 500)] },
    ]);

    // Holding both sides of one market is one market, so it must not clear a 2-market threshold.
    const stats = await discoverFromHolders({ minMarketsHeld: 2 });

    expect(stats.added).toBe(0);
    expect(stats.belowThreshold).toBe(1);
  });

  it("ignores dust holdings", async () => {
    findManyMarkets.mockResolvedValue([market("c1"), market("c2")]);
    fetchHolders.mockResolvedValue([{ token: "t", holders: [holder("0xDUST", 3)] }]);

    const stats = await discoverFromHolders({ minShares: 100, minMarketsHeld: 1 });

    expect(stats.added).toBe(0);
    expect(stats.uniqueWallets).toBe(0);
  });

  it("does not re-add a wallet already on the watchlist", async () => {
    findManyMarkets.mockResolvedValue([market("c1"), market("c2")]);
    fetchHolders.mockResolvedValue([{ token: "t", holders: [holder("0xKNOWN")] }]);
    findManyTraders.mockResolvedValue([{ wallet: "0xknown" }]);

    const stats = await discoverFromHolders({ minMarketsHeld: 1 });

    expect(stats.alreadyTracked).toBe(1);
    expect(stats.added).toBe(0);
  });

  it("keeps going when one market's holders cannot be fetched", async () => {
    findManyMarkets.mockResolvedValue([market("c1"), market("c2"), market("c3")]);
    fetchHolders.mockImplementation((conditionId: string) => {
      if (conditionId === "c2") return Promise.reject(new Error("500"));
      return Promise.resolve([{ token: "t", holders: [holder("0xAAA")] }]);
    });

    const stats = await discoverFromHolders({ minMarketsHeld: 2 });

    expect(stats.marketsSampled).toBe(3);
    expect(stats.added).toBe(1);
  });

  it("records a neutral note that does not imply the wallet is profitable", async () => {
    findManyMarkets.mockResolvedValue([market("c1"), market("c2")]);
    fetchHolders.mockResolvedValue([{ token: "t", holders: [holder("0xAAA")] }]);

    await discoverFromHolders({ minMarketsHeld: 1 });

    const note: string = createMany.mock.calls[0][0].data[0].notes.toLowerCase();
    expect(note).toContain("carries no implication");
    for (const word of ["profitable trader", "top trader", "winning", "smart money"]) {
      expect(note).not.toContain(word);
    }
  });

  it("uses a public profile name but never a pseudonym", async () => {
    findManyMarkets.mockResolvedValue([market("c1"), market("c2")]);
    fetchHolders.mockResolvedValue([
      {
        token: "t",
        holders: [
          holder("0xAAA", 1000, { name: "RealName", displayUsernamePublic: true }),
          holder("0xBBB", 1000, { name: "Hidden", displayUsernamePublic: false, pseudonym: "Odd-Pony" }),
        ],
      },
    ]);

    await discoverFromHolders({ minMarketsHeld: 1 });

    const created = createMany.mock.calls[0][0].data as Array<{ wallet: string; displayName: string }>;
    expect(created.find((c) => c.wallet === "0xaaa")?.displayName).toBe("RealName");
    // No public name means a truncated address, not the auto-generated pseudonym.
    const bbb = created.find((c) => c.wallet === "0xbbb")?.displayName;
    expect(bbb).not.toBe("Hidden");
    expect(bbb).not.toBe("Odd-Pony");
    expect(bbb).toContain("…");
  });

  it("assigns a specialty only when one category clearly dominates", async () => {
    findManyMarkets.mockResolvedValue([
      market("c1", Category.SPORTS),
      market("c2", Category.SPORTS),
      market("c3", Category.POLITICS),
    ]);
    fetchHolders.mockResolvedValue([{ token: "t", holders: [holder("0xAAA")] }]);

    await discoverFromHolders({ minMarketsHeld: 1 });

    expect(createMany.mock.calls[0][0].data[0].specialty).toBe(Category.SPORTS);
  });

  it("refuses to guess a specialty on a tie", async () => {
    findManyMarkets.mockResolvedValue([
      market("c1", Category.SPORTS),
      market("c2", Category.POLITICS),
    ]);
    fetchHolders.mockResolvedValue([{ token: "t", holders: [holder("0xAAA")] }]);

    await discoverFromHolders({ minMarketsHeld: 1 });

    expect(createMany.mock.calls[0][0].data[0].specialty).toBe(Category.UNKNOWN);
  });

  it("honours the cap on new traders, keeping the most active", async () => {
    findManyMarkets.mockResolvedValue([market("c1"), market("c2"), market("c3")]);
    fetchHolders.mockImplementation((conditionId: string) =>
      Promise.resolve([
        {
          token: "t",
          // 0xBUSY appears in all three, 0xRARE only in c1.
          holders: conditionId === "c1" ? [holder("0xBUSY"), holder("0xRARE")] : [holder("0xBUSY")],
        },
      ]),
    );

    const stats = await discoverFromHolders({ minMarketsHeld: 1, maxNewTraders: 1 });

    expect(stats.added).toBe(1);
    expect(createMany.mock.calls[0][0].data[0].wallet).toBe("0xbusy");
  });

  it("does nothing gracefully when there are no markets", async () => {
    findManyMarkets.mockResolvedValue([]);

    const stats = await discoverFromHolders();

    expect(stats).toMatchObject({ marketsSampled: 0, added: 0, uniqueWallets: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });
});

function trade(
  proxyWallet: string,
  conditionId: string,
  size = 1000,
  price = 0.5,
  extra: Record<string, unknown> = {},
) {
  return { proxyWallet, conditionId, size, price, ...extra };
}

describe("discoverFromTape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyTraders.mockResolvedValue([]);
    createMany.mockResolvedValue({ count: 0 });
  });

  it("adds a wallet active across several distinct markets", async () => {
    fetchTrades.mockResolvedValueOnce([trade("0xAAA", "c1"), trade("0xAAA", "c2")]);

    const stats = await discoverFromTape({ pageSize: 500, minMarketsTraded: 2 });

    expect(stats.added).toBe(1);
    expect(createMany.mock.calls[0][0].data[0].wallet).toBe("0xaaa");
  });

  it("skips a single-market grinder, which is what the tape over-produces", async () => {
    // The tape's bias is toward high-FREQUENCY wallets, so breadth is the filter that matters.
    fetchTrades.mockResolvedValueOnce([
      trade("0xBOT", "c1"),
      trade("0xBOT", "c1"),
      trade("0xBOT", "c1"),
    ]);

    const stats = await discoverFromTape({ pageSize: 500, minMarketsTraded: 2 });

    expect(stats.belowThreshold).toBe(1);
    expect(stats.added).toBe(0);
  });

  it("ignores fills below the notional floor", async () => {
    // size x price, not size: 10 shares at 2c is 20c of risk, not a signal.
    fetchTrades.mockResolvedValueOnce([trade("0xDUST", "c1", 10, 0.02)]);

    const stats = await discoverFromTape({ pageSize: 500, minTradeUsd: 50, minMarketsTraded: 1 });

    expect(stats.uniqueWallets).toBe(0);
    expect(stats.added).toBe(0);
  });

  it("pages through the tape until a short page arrives", async () => {
    fetchTrades
      .mockResolvedValueOnce([trade("0xAAA", "c1"), trade("0xAAA", "c2")])
      .mockResolvedValueOnce([trade("0xBBB", "c3")]);

    await discoverFromTape({ pageSize: 2, maxTrades: 100, minMarketsTraded: 1 });

    expect(fetchTrades).toHaveBeenCalledTimes(2);
    expect(fetchTrades.mock.calls[0][0]).toMatchObject({ limit: 2, offset: 0 });
    expect(fetchTrades.mock.calls[1][0]).toMatchObject({ limit: 2, offset: 2 });
  });

  it("stops at the trade budget rather than walking the whole tape", async () => {
    fetchTrades.mockResolvedValue([trade("0xAAA", "c1"), trade("0xAAA", "c2")]);

    await discoverFromTape({ pageSize: 2, maxTrades: 4, minMarketsTraded: 1 });

    expect(fetchTrades).toHaveBeenCalledTimes(2);
  });

  it("keeps whatever it collected when a page fails", async () => {
    fetchTrades
      .mockResolvedValueOnce([trade("0xAAA", "c1"), trade("0xAAA", "c2")])
      .mockRejectedValueOnce(new Error("500"));

    const stats = await discoverFromTape({ pageSize: 2, maxTrades: 100, minMarketsTraded: 1 });

    expect(stats.added).toBe(1);
  });

  it("does not re-add a wallet already on the watchlist", async () => {
    fetchTrades.mockResolvedValueOnce([trade("0xKNOWN", "c1"), trade("0xKNOWN", "c2")]);
    findManyTraders.mockResolvedValue([{ wallet: "0xknown" }]);

    const stats = await discoverFromTape({ pageSize: 500, minMarketsTraded: 1 });

    expect(stats.alreadyTracked).toBe(1);
    expect(stats.added).toBe(0);
  });

  it("records a note that claims neither profit nor size, and admits the bot bias", async () => {
    fetchTrades.mockResolvedValueOnce([trade("0xAAA", "c1"), trade("0xAAA", "c2")]);

    await discoverFromTape({ pageSize: 500, minMarketsTraded: 1 });

    const note: string = createMany.mock.calls[0][0].data[0].notes.toLowerCase();
    expect(note).toContain("carries no implication");
    expect(note).toContain("automated");
    for (const word of ["profitable trader", "top trader", "winning", "smart money"]) {
      expect(note).not.toContain(word);
    }
  });

  it("prefers breadth over notional when capping", async () => {
    fetchTrades.mockResolvedValueOnce([
      trade("0xWIDE", "c1"),
      trade("0xWIDE", "c2"),
      trade("0xWIDE", "c3"),
      trade("0xBIG", "c4", 1_000_000),
    ]);

    const stats = await discoverFromTape({ pageSize: 500, minMarketsTraded: 1, maxNewTraders: 1 });

    expect(stats.added).toBe(1);
    expect(createMany.mock.calls[0][0].data[0].wallet).toBe("0xwide");
  });

  it("does nothing gracefully when the tape is empty", async () => {
    fetchTrades.mockResolvedValueOnce([]);

    const stats = await discoverFromTape({ pageSize: 500 });

    expect(stats).toMatchObject({ added: 0, uniqueWallets: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });
});
