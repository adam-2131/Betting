/**
 * Single-user password gate.
 *
 * The app holds no wallet, no key and no Polymarket credential, so the worst case here is
 * disclosure rather than theft. But a bet log is a record of your money and your judgement, and
 * once this runs on a public address anything that can reach the port can read it. That is reason
 * enough to put a door on it.
 *
 * Deliberately not an auth library, and not user accounts. There is one user. A dependency with a
 * database of sessions and a password-reset flow would be more code, more surface and no more
 * safety for exactly one person who knows their own password.
 *
 * WHAT THIS IS NOT. It is not protection against someone who can read your traffic — plain HTTP
 * sends the password in the clear. Put a Cloudflare Tunnel or an SSH tunnel in front of it for
 * that; DEPLOY.md covers both, and both are free.
 *
 * Uses Web Crypto rather than `node:crypto` because Next middleware runs on the Edge runtime,
 * where the Node module does not exist.
 */

export const SESSION_COOKIE = "polyalpha_session";

/**
 * Fixed application salt.
 *
 * Not a secret — its job is to make the stored token specific to this app, so a token lifted from
 * here is not a bare hash of the password that could be looked up in a rainbow table and reused
 * somewhere the same password was chosen.
 */
const SALT = "polyalpha:v1:session";

/** True when a password is configured. With none set, the app is open — the local default. */
export function authEnabled(password = process.env.APP_PASSWORD): boolean {
  return typeof password === "string" && password.trim().length > 0;
}

/** The value the session cookie must hold for a given password. */
export async function sessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`${SALT}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Length-independent comparison.
 *
 * The lengths are always equal here — both sides are hex SHA-256 — so this is belt and braces
 * rather than load-bearing, but a comparison that returns early on the first differing character
 * is the kind of thing that gets copied somewhere it does matter.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isValidSession(
  cookieValue: string | undefined,
  password = process.env.APP_PASSWORD,
): Promise<boolean> {
  if (!authEnabled(password)) return true;
  if (!cookieValue) return false;
  return tokensMatch(cookieValue, await sessionToken(password as string));
}
