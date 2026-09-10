import { describe, expect, it } from "vitest";
import { Category } from "@prisma/client";
import { parseCategories, resolutionHours, RESOLUTION_WINDOWS } from "./filter-params";

describe("parseCategories", () => {
  it("reads a comma separated list", () => {
    expect(parseCategories("POLITICS,SPORTS")).toEqual([Category.POLITICS, Category.SPORTS]);
  });

  it("is case and whitespace insensitive", () => {
    expect(parseCategories(" politics , Sports ")).toEqual([Category.POLITICS, Category.SPORTS]);
  });

  it("discards values that are not real categories", () => {
    // The query string is user-editable, so an unknown value must not reach a Prisma enum filter.
    expect(parseCategories("POLITICS,NOT_A_CATEGORY,'; DROP TABLE--")).toEqual([Category.POLITICS]);
  });

  it("returns an empty list for absent or empty input", () => {
    expect(parseCategories(undefined)).toEqual([]);
    expect(parseCategories("")).toEqual([]);
    expect(parseCategories(",,")).toEqual([]);
  });

  it("accepts the array form Next can produce for a repeated parameter", () => {
    expect(parseCategories(["POLITICS", "CRYPTO"])).toEqual([Category.POLITICS, Category.CRYPTO]);
  });
});

describe("resolutionHours", () => {
  it("maps each window to its hour count", () => {
    expect(resolutionHours("24h")).toBe(24);
    expect(resolutionHours("3d")).toBe(72);
    expect(resolutionHours("7d")).toBe(168);
    expect(resolutionHours("30d")).toBe(720);
  });

  it("treats any and unknown values as no filter", () => {
    expect(resolutionHours("any")).toBeNull();
    expect(resolutionHours("nonsense")).toBeNull();
    expect(resolutionHours(undefined)).toBeNull();
  });

  it("keeps the window options strictly increasing", () => {
    const hours = RESOLUTION_WINDOWS.map((w) => w.hours).filter((h): h is number => h !== null);
    for (let i = 1; i < hours.length; i++) {
      expect(hours[i]).toBeGreaterThan(hours[i - 1]);
    }
  });
});
