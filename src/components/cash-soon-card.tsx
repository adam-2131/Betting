/**
 * One row of the Cash Soon board.
 *
 * Deliberately leads with different numbers from `OpportunityCard`. That card answers "is this
 * signal worth acting on"; this one answers "how much does a dollar earn per day it is locked up,
 * and how much of that survives the order book". The headline is return per day, the entry price
 * shown is the one you would actually pay rather than the mid, and the gap between the two prices
 * is stated outright because on a three-day trade it is frequently the whole result.
 */
import Link from "next/link";
import {
  formatCents,
  formatPercent,
  formatSignedPercent,
  formatTimeUntil,
  formatUsd,
  safeNumber,
  UNAVAILABLE,
} from "@/lib/num";
import type { ShortTermRow, StoredHorizon } from "@/lib/queries/short-term";
import { Badge, Card, KeyValue, cn, type Tone } from "@/components/ui/primitives";
import { ViewOnPolymarket } from "@/components/ui/view-on-polymarket";

function scoreTone(score: number | null): Tone {
  if (score === null) return "neutral";
  if (score >= 65) return "positive";
  if (score >= 45) return "accent";
  return "neutral";
}

/** Per-day return, the headline. Coloured only when it is genuinely positive. */
function returnTone(returnPerDay: number | null): Tone {
  if (returnPerDay === null) return "neutral";
  if (returnPerDay <= 0) return "negative";
  if (returnPerDay >= 0.02) return "positive";
  return "accent";
}

function retentionTone(retention: number | null): Tone {
  if (retention === null) return "neutral";
  if (retention >= 0.7) return "positive";
  if (retention >= 0.35) return "warning";
  return "negative";
}

export function CashSoonCard({
  row,
  horizon,
  rank,
  bankroll,
}: {
  row: ShortTermRow;
  horizon: StoredHorizon | null;
  rank: number;
  bankroll: number;
}) {
  const outcome = row.market.outcomes[row.outcomeIndex] ?? `Outcome ${row.outcomeIndex}`;
  const returnPerDay = safeNumber(row.returnPerDay);
  const effectivePrice = safeNumber(row.effectivePrice);
  const midPrice = safeNumber(row.currentPrice);
  const retention = safeNumber(row.edgeRetention);
  const netEdge = safeNumber(row.netEdgePoints);

  // What the user's actual bankroll would return here, which is the only figure that is about
  // them rather than about the market.
  const profitIfRight =
    effectivePrice !== null && effectivePrice > 0
      ? bankroll * ((1 - effectivePrice) / effectivePrice)
      : null;

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-2xs text-dim">#{rank}</span>
            <Badge tone="neutral" size="sm">
              {outcome.toUpperCase()}
            </Badge>
            {row.gamePhase ? (
              <Badge tone="accent" size="sm">
                {row.gamePhase.replace(/_/g, " ")}
              </Badge>
            ) : null}
          </div>
          <Link
            href={`/opportunities/${row.id}`}
            className="mt-1 block text-sm leading-5 text-fg hover:text-accent"
          >
            {row.market.question}
          </Link>
        </div>

        <div className="shrink-0 text-right">
          <div
            className={cn(
              "font-mono text-2xl leading-none tabular-nums",
              returnTone(returnPerDay) === "positive"
                ? "text-positive"
                : returnTone(returnPerDay) === "negative"
                  ? "text-negative"
                  : "text-fg",
            )}
          >
            {returnPerDay === null ? UNAVAILABLE : formatSignedPercent(returnPerDay, 2)}
          </div>
          <div className="mt-0.5 text-2xs text-dim">per day of capital</div>
        </div>
      </div>

      {horizon?.verdict ? (
        <p className="rounded border border-line bg-elevated/40 px-3 py-2 text-xs leading-5 text-muted">
          {horizon.verdict}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
        <KeyValue
          label="Settles in"
          value={formatTimeUntil(row.settlesAt)}
          hint={
            horizon?.capitalDaysFloored
              ? "Per-day figures use a one-day minimum"
              : row.market.gameStartTime
                ? "Estimated from the game length"
                : undefined
          }
        />
        <KeyValue
          label="You pay"
          value={formatCents(effectivePrice)}
          // The single most important disclosure on this card.
          hint={
            midPrice !== null && effectivePrice !== null
              ? `Mid is ${formatCents(midPrice)}`
              : "Ask plus slippage"
          }
          tone="warning"
        />
        <KeyValue
          label="Edge kept"
          value={retention === null ? UNAVAILABLE : formatPercent(retention, 0)}
          hint="Survives the spread"
          tone={retentionTone(retention)}
        />
        <KeyValue
          label="Horizon score"
          value={row.horizonScore === null ? UNAVAILABLE : Math.round(row.horizonScore)}
          hint={`Opportunity score ${Math.round(row.score)}`}
          tone={scoreTone(row.horizonScore)}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-2xs text-dim">
          <span>
            Net edge{" "}
            <span
              className={cn(
                "font-mono tabular-nums",
                netEdge !== null && netEdge > 0 ? "text-positive" : "text-negative",
              )}
            >
              {netEdge === null ? UNAVAILABLE : `${netEdge > 0 ? "+" : ""}${netEdge.toFixed(1)} pts`}
            </span>
          </span>
          <span>
            {row.qualifiedTraders} qualified trader{row.qualifiedTraders === 1 ? "" : "s"}
          </span>
          <span>Liquidity {formatUsd(row.liquidity)}</span>
          <span>
            {formatUsd(bankroll)} returns{" "}
            <span className="font-mono tabular-nums text-fg">
              {profitIfRight === null ? UNAVAILABLE : formatUsd(profitIfRight)}
            </span>{" "}
            if right, {formatUsd(bankroll)} lost if wrong
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/opportunities/${row.id}`}
            className="rounded border border-line px-2.5 py-1 text-2xs uppercase tracking-caps text-muted hover:border-accent/40 hover:text-accent"
          >
            Full breakdown
          </Link>
          <ViewOnPolymarket slug={row.market.slug} eventSlug={row.market.eventSlug} />
        </div>
      </div>
    </Card>
  );
}
