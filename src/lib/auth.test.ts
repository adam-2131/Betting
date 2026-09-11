import { describe, expect, it } from "vitest";
import { authEnabled, isValidSession, sessionToken, tokensMatch } from "./auth";

const PASSWORD = "correct-horse-battery-staple";

describe("authEnabled", () => {
  it("is off when no password is set, which keeps local use frictionless", () => {
    expect(authEnabled(undefined)).toBe(false);
    expect(authEnabled("")).toBe(false);
    expect(authEnabled("   ")).toBe(false);
  });

  it("is on as soon as one is", () => {
    expect(authEnabled(PASSWORD)).toBe(true);
  });
});

describe("sessionToken", () => {
  it("is stable for the same password, so a session survives a restart", async () => {
    expect(await sessionToken(PASSWORD)).toBe(await sessionToken(PASSWORD));
  });

  it("differs for a different password", async () => {
    expect(await sessionToken(PASSWORD)).not.toBe(await sessionToken(`${PASSWORD}!`));
  });

  it("is not a bare hash of the password", async () => {
    // Salted, so a token lifted from here cannot be looked up in a rainbow table and reused
    // wherever the same password was chosen.
    const bare = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PASSWORD));
    const bareHex = [...new Uint8Array(bare)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await sessionToken(PASSWORD)).not.toBe(bareHex);
  });

  it("is hex SHA-256", async () => {
    expect(await sessionToken(PASSWORD)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isValidSession", () => {
  it("lets everything through when no password is configured", async () => {
    expect(await isValidSession(undefined, undefined)).toBe(true);
    expect(await isValidSession("anything", "")).toBe(true);
  });

  it("accepts the token minted from the configured password", async () => {
    expect(await isValidSession(await sessionToken(PASSWORD), PASSWORD)).toBe(true);
  });

  it("rejects a missing cookie", async () => {
    expect(await isValidSession(undefined, PASSWORD)).toBe(false);
    expect(await isValidSession("", PASSWORD)).toBe(false);
  });

  it("rejects a forged cookie", async () => {
    expect(await isValidSession("deadbeef", PASSWORD)).toBe(false);
    // Right shape, wrong value — the case a length check alone would miss.
    expect(await isValidSession("0".repeat(64), PASSWORD)).toBe(false);
  });

  it("rejects the raw password used as a cookie", async () => {
    expect(await isValidSession(PASSWORD, PASSWORD)).toBe(false);
  });

  it("rejects a token minted from a different password", async () => {
    expect(await isValidSession(await sessionToken("other"), PASSWORD)).toBe(false);
  });
});

describe("tokensMatch", () => {
  it("compares equal strings as equal", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
  });

  it("rejects differing strings, including a shared prefix", () => {
    expect(tokensMatch("abc123", "abc124")).toBe(false);
    expect(tokensMatch("abc", "abcdef")).toBe(false);
    expect(tokensMatch("", "a")).toBe(false);
  });
});
