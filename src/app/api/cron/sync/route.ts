/**
 * Scheduled sync endpoint.
 *
 * Same code path as `npm run sync`, exposed for a cron scheduler. Guarded by a bearer token so a
 * long-running sync cannot be triggered by anyone who can reach the port.
 *
 * The token authorises *this endpoint only*. It is not a Polymarket credential — PolyAlpha holds
 * no account, key or wallet of any kind.
 *
 *   curl -X POST http://localhost:3000/api/cron/sync \
 *        -H "Authorization: Bearer $CRON_SECRET"
 */
import { NextResponse } from "next/server";
import { ALL_STAGES, EVERY_STAGE, runSync, type SyncStage } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Constant-time-ish comparison, so a wrong token cannot be found by timing the response. */
function tokensMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function authorize(request: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length === 0) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured on the server." },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !tokensMatch(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

function parseStages(value: string | null): SyncStage[] | null {
  if (!value) return null;
  const requested = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = requested.filter((s): s is SyncStage =>
    (EVERY_STAGE as readonly string[]).includes(s),
  );
  return valid.length > 0 ? valid : null;
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const stages = parseStages(url.searchParams.get("stages"));
  const traderLimit = Number(url.searchParams.get("traders")) || undefined;
  const marketLimit = Number(url.searchParams.get("markets")) || undefined;

  try {
    const result = await runSync(stages ?? ALL_STAGES, { traderLimit, marketLimit });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** Liveness only — never runs a sync, so a stray GET cannot start one. */
export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  return NextResponse.json({ ok: true, hint: "POST to this endpoint to run a sync." });
}
