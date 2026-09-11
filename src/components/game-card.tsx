/**
 * One game on the sports board, with every scored side underneath it.
 *
 * Grouped by event rather than listed flat because a game is the unit a bettor thinks in: the
 * moneyline, the spread and the total on the same fixture are one decision, not three unrelated
 * rows. Sides are ordered by horizon score within the game, but the games themselves run
 * chronologically — a slate is read by kickoff time.
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
import { describeBet, stakeOutcome } from "@/lib/bet-instruction";
import type { GameGroup, ShortTermRow, StoredSportsAngle } from "@/lib/queries/short-term";
import type { GamePhase, LineVerdict } from "@/lib/scoring/sports";
import { Badge, Card, cn, type Tone } from "@/components/ui/primitives";
import { ViewOnPolymarket } from "@/components/ui/view-on-polymarket";

const PHASE_META: Record<GamePhase, { label: string; tone: Tone }> = {
  EARLY: { label: "DAYS AWAY", tone: "neutral" },
  APPROACHING: { label: "APPROACHING", tone: "accent" },
  IMMINENT: { label: "IMMINENT", tone: "positive" },
  IN_PLAY: { label: "IN PLAY", tone: "negative" },
  ENDED: { label: "AWAITING SETTLEMENT", tone: "warning" },
  NOT_A_GAME: { label: "SEASON MARKET", tone: "neutral" },
};

/**
 * The four readings that come from crossing the line move with current flow. Tone matters here:
 * a cheap-looking entry that the smart money is exiting has to read as a warning, not a discount.
 */
const VERDICT_META: Record<LineVerdict, { label: string; tone: Tone } | null> = {
  STEAM: { label: "STEAM", tone: "positive" },
  CONFIRMED: { label: "LINE CONFIRMED", tone: "accent" },
  DOUBLING_DOWN: { label: "DOUBLING DOWN", tone: "accent" },
  CAPITULATING: { label: "SMART MONEY EXITING", tone: "negative" },
  FLAT: { label: "LINE FLAT", tone: "neutral" },
  UNKNOWN: null,
};

function SideRow({ row, angle }: { row: ShortTermRow; angle: StoredSportsAngle | null }) {
  const outcome = row.market.outcomes[row.outcomeIndex] ?? `Outcome ${row.outcomeIndex}`;
  const returnPerDay = safeNumber(row.returnPerDay);
  const effectivePrice = safeNumber(row.effectivePrice);
  const netEdge = safeNumber(row.netEdgePoints);
  const winProbability = safeNumber(row.modelEstimateMid);
  const verdict = angle ? VERDICT_META[angle.lineVerdict] : null;

  const instruction = describeBet({
    question: row.market.question,
    outcomeLabel: outcome,
    outcomes: row.market.outcomes,
    outcomeIndex: row.outcomeIndex,
    sportsMarketType: row.market.sportsMarketType,
  });
  const unit = stakeOutcome(1, effectivePrice);

  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* The instruction, not the bare outcome label — "No" on its own says nothing. */}
            <span className="text-xs font-medium text-fg">{instruction.action}</span>
            {angle ? (
              <Badge tone="neutral" size="sm">
                {angle.kind.label}
              </Badge>
            ) : null}
            {verdict ? (
              <Badge tone={verdict.tone} size="sm">
                {verdict.label}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-2xs leading-4 text-muted">
            <span className="text-positive">Wins if</span> {instruction.winsIf}
          </p>
        </div>

        <div className="flex shrink-0 items-baseline gap-4 text-2xs">
          <span className="text-dim">
            $1 pays{" "}
            <span className="font-mono tabular-nums text-positive">
              {unit === null ? UNAVAILABLE : `+${formatUsd(unit.profit)}`}
            </span>
          </span>
          <span className="text-dim">
            chance{" "}
            <span className="font-mono tabular-nums text-fg">
              {winProbability === null ? UNAVAILABLE : formatPercent(winProbability, 0)}
            </span>
          </span>
          <span className="text-dim">
            pay{" "}
            <span className="font-mono tabular-nums text-fg">{formatCents(effectivePrice)}</span>
          </span>
          <span className="text-dim">
            edge{" "}
            <span
              className={cn(
                "font-mono tabular-nums",
                netEdge !== null && netEdge > 0 ? "text-positive" : "text-negative",
              )}
            >
              {netEdge === null ? UNAVAILABLE : `${netEdge > 0 ? "+" : ""}${netEdge.toFixed(1)}`}
            </span>
          </span>
          <span
            className={cn(
              "w-16 text-right font-mono tabular-nums",
              returnPerDay !== null && returnPerDay > 0 ? "text-positive" : "text-muted",
            )}
          >
            {returnPerDay === null ? UNAVAILABLE : formatSignedPercent(returnPerDay, 2)}
          </span>
          <Link
            href={`/opportunities/${row.id}`}
            className="text-muted underline-offset-2 hover:text-accent hover:underline"
          >
            detail
          </Link>
        </div>
      </div>

      {angle && angle.lateMoneyShare !== null && angle.lateMoneyShare >= 0.6 ? (
        <p className="mt-1 text-2xs leading-4 text-muted">
          {formatPercent(angle.lateMoneyShare, 0)} of the tracked money here arrived within a day of
          kickoff ({formatUsd(angle.lateMoneyUsd)} late against {formatUsd(angle.earlyMoneyUsd)}{" "}
          early).
        </p>
      ) : null}

      {angle?.warnings.map((warning) => (
        <p key={warning} className="mt-1 text-2xs leading-4 text-warning">
          {warning}
        </p>
      ))}
    </div>
  );
}

export function GameCard({ game, readAngle }: {
  game: GameGroup;
  readAngle: (row: ShortTermRow) => StoredSportsAngle | null;
}) {
  const phase = PHASE_META[game.phase] ?? PHASE_META.NOT_A_GAME;
  const first = game.rows[0];

  return (
    <Card className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={phase.tone} size="sm">
              {phase.label}
            </Badge>
            {game.league ? (
              <Badge tone="neutral" size="sm">
                {game.league.toUpperCase()}
              </Badge>
            ) : null}
          </div>
          <h3 className="mt-1 text-sm font-medium leading-5 text-fg">{game.title}</h3>
        </div>

        <div className="shrink-0 text-right">
          <div className="font-mono text-lg leading-none tabular-nums text-fg">
            {formatTimeUntil(game.gameStartTime)}
          </div>
          <div className="mt-0.5 text-2xs text-dim">
            {game.gameStartTime
              ? game.gameStartTime.toLocaleString("en-US", {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZoneName: "short",
                })
              : "kickoff unavailable"}
          </div>
        </div>
      </div>

      <div className="divide-y divide-line border-t border-line">
        {game.rows.map((row) => (
          <SideRow key={row.id} row={row} angle={readAngle(row)} />
        ))}
      </div>

      <div className="flex items-center justify-end border-t border-line pt-2">
        <ViewOnPolymarket slug={first?.market.slug} eventSlug={first?.market.eventSlug} />
      </div>
    </Card>
  );
}
