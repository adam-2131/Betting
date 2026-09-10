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

vi.mock("@/lib/polymarket/data", () => ({
  fetchHolders: (...args: unknown[]) => fetchHolders(...args),
}));

const { discoverFromHolders } = await import("./discover");

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
