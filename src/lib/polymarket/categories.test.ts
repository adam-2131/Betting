import { Category } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { categoryFromTags, resolveCategory, scoreCategories } from "./categories";

/**
 * Tag sets in these tests are verbatim from live Gamma responses, not invented.
 */
describe("categoryFromTags — real tag sets from production", () => {
  it("files Fed rate markets under Economics, not Politics", () => {
    // Regression: "economic-policy" contains "policy", a Politics keyword, and Politics used to
    // be checked first, so every FOMC market was misfiled.
    expect(
      categoryFromTags(["fomc", "economic-policy", "fed-rates", "jerome-powell"]),
    ).toBe(Category.ECONOMICS);
  });

  it("files a politically-themed memecoin market under Crypto", () => {
    // Regression: the bare `politics` tag outranked three specific crypto tags.
    expect(
      categoryFromTags([
        "fdv", "biden", "crypto", "laptop", "s-laptop", "politics", "memecoins",
        "pre-market", "hunter-biden",
      ]),
    ).toBe(Category.CRYPTO);
  });

  it("files a Bitcoin price market under Crypto", () => {
    expect(categoryFromTags(["bitcoin", "monthly", "hit-price", "crypto"])).toBe(Category.CRYPTO);
  });

  it("files a Premier League market under Sports", () => {
    expect(categoryFromTags(["EPL", "soccer", "sports"])).toBe(Category.SPORTS);
  });

  it("files a US presidential election market under Politics", () => {
    expect(
      categoryFromTags(["president", "united-states", "us-presidential-election", "elections"]),
    ).toBe(Category.POLITICS);
  });

  it("files a Russia/Ukraine market under Geopolitics rather than Politics", () => {
    expect(categoryFromTags(["politics", "ukraine", "geopolitics", "world"])).toBe(
      Category.GEOPOLITICS,
    );
  });
});

describe("categoryFromTags — weighting", () => {
  it("lets several specific tags outweigh one generic tag", () => {
    const scores = scoreCategories(["fomc", "fed-rates", "politics"]);
    expect(scores.get(Category.ECONOMICS)!).toBeGreaterThan(scores.get(Category.POLITICS)!);
  });

  it("breaks ties toward the more specific domain rather than Politics", () => {
    // Politics gets `politics`(generic) + `biden`(specific); Crypto gets `crypto`(generic)
    // + `memecoins`(specific). Equal scores, and the tie-break must not pick Politics.
    expect(categoryFromTags(["politics", "biden", "crypto", "memecoins"])).toBe(Category.CRYPTO);
  });

  it("counts each tag at most once per category", () => {
    // "bitcoin" matches only one crypto keyword slot, so this cannot exceed the specific weight.
    expect(scoreCategories(["bitcoin"]).get(Category.CRYPTO)).toBe(3);
  });
});

describe("categoryFromTags — fallbacks", () => {
  it("returns UNKNOWN when there are no tags", () => {
    expect(categoryFromTags([])).toBe(Category.UNKNOWN);
    expect(categoryFromTags([null, undefined, ""])).toBe(Category.UNKNOWN);
  });

  it("returns OTHER when tags exist but match nothing", () => {
    expect(categoryFromTags(["caitlin-clark-shoes", "zzzz", "qqq"])).toBe(Category.OTHER);
  });
});

describe("resolveCategory", () => {
  it("prefers tags over the question text", () => {
    expect(resolveCategory(["bitcoin", "crypto"], "Will the president resign?")).toBe(
      Category.CRYPTO,
    );
  });

  it("falls back to the question text when tags are uninformative", () => {
    expect(resolveCategory(["zzz"], "Will Bitcoin reach $100,000 in September?")).toBe(
      Category.CRYPTO,
    );
  });

  it("returns UNKNOWN when neither tags nor text help", () => {
    expect(resolveCategory([], "Will the thing happen?")).toBe(Category.UNKNOWN);
  });
});
