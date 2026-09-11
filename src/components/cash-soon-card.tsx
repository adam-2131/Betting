/**
 * One row of the Cash Soon board.
 *
 * Ordered by what a reader actually needs, in sequence: what to click, what has to happen for it
 * to pay, what a stake returns, how often that happens, and only then why it is on the list at
 * all. The scoring vocabulary is pushed to the bottom — a card should be usable without first
 * learning what an entry gap is.
 *
 * The stake illustration is fixed at $1 rather than at the configured bankroll. One dollar is the
 * unit every row can be compared in, it is close to Polymarket's order minimum, and a figure that
 * moves when a setting changes is harder to build intuition against. The bankroll number is still
 * shown beside it when it differs.
 *
 * Two things are deliberately given equal weight: the profit if it wins, and how often it does
 * not. Return figures alone read as though they arrive every time.
 */
import Link from "next/link";
import {
  formatCents,
  formatSignedPercent,
  formatTimeUntil,
  formatUsd,
  safeNumber,
  UNAVAILABLE,
} from "@/lib/num";
import { describeBet, stakeOutcome } from "@/lib/bet-instruction";
import type { ShortTermRow, StoredHorizon, StoredSportsAngle } from "@/lib/queries/short-term";
import { Badge, Card, cn, type Tone } from "@/components/ui/primitives";
import { LogBetButton } from "@/components/log-bet-button";
import { ViewOnPolymarket } from "@/components/ui/view-on-polymarket";

/** The illustration stake. See the module header for why it is not the bankroll. */
const UNIT_STAKE = 1;

function scoreTone(score: number | null): Tone {
  if (score === null) return "neutral";
  if (score >= 65) return "positive";
  if (score >= 45) return "accent";
  return "neutral";
}

function chanceTone(probability: number | null): Tone {
  if (probability === null) return "neutral";
  if (probability >= 0.6) return "positive";
  if (probability >= 0.4) return "accent";
  return "warning";
}

function reasonList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : ((item as { text?: string })?.text ?? "")))
    .filter((text): text is string => typeof text === "string" && text.length > 0);
}

export function CashSoonCard({
  row,
  horizon,
  sports,
  rank,
  bankroll,
}: {
  row: ShortTermRow;
  horizon: StoredHorizon | null;
  sports: StoredSportsAngle | null;
  rank: number;
  bankroll: number;
}) {
  const outcome = row.market.outcomes[row.outcomeIndex] ?? `Outcome ${row.outcomeIndex}`;
  const effectivePrice = safeNumber(row.effectivePrice);
  const midPrice = safeNumber(row.currentPrice);
  const returnPerDay = safeNumber(row.returnPerDay);
  const retention = safeNumber(row.edgeRetention);
  const winProbability = safeNumber(horizon?.estimatedWinProbability);
  const winPercent = winProbability === null ? null : Math.round(winProbability * 100);

  const instruction = describeBet({
    question: row.market.question,
    outcomeLabel: outcome,
    outcomes: row.market.outcomes,
    outcomeIndex: row.outcomeIndex,
    sportsMarketType: row.market.sportsMarketType,
  });

  const unit = stakeOutcome(UNIT_STAKE, effectivePrice);
  const atBankroll = bankroll !== UNIT_STAKE ? stakeOutcome(bankroll, effectivePrice) : null;

  // "Why" is assembled from the strongest evidence, not from every reason available. Three lines
  // is what a reader will actually take in before deciding whether to open the market.
  const why = [
    ...(sports?.notes ?? []),
    ...reasonList(row.reasonsFor),
    retention !== null
      ? `${Math.round(retention * 100)}% of the estimated edge is still there after paying the spread.`
      : "",
  ]
    .filter(Boolean)
    .slice(0, 3);

  const warnings = sports?.warnings ?? [];

  return (
    <Card className="space-y-3">
      {/* --- Header: which market, and how soon ------------------------------ */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-2xs text-dim">#{rank}</span>
            {row.market.league ? (
              <Badge tone="neutral" size="sm">
                {row.market.league.toUpperCase()}
              </Badge>
            ) : null}
            {row.gamePhase ? (
              <Badge tone={row.gamePhase === "IMMINENT" ? "positive" : "accent"} size="sm">
                {row.gamePhase.replace(/_/g, " ")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-2xs leading-4 text-muted">{row.market.question}</p>
        </div>

        <div className="shrink-0 text-right">
          <div className="font-mono text-lg leading-none tabular-nums text-fg">
            {formatTimeUntil(row.settlesAt)}
          </div>
          <div className="mt-0.5 text-2xs text-dim">until it settles</div>
        </div>
      </div>

      {/* --- The instruction. The reason the card exists. -------------------- */}
      <div className="rounded border border-accent/30 bg-accent/5 px-3 py-2.5">
        <div className="text-2xs uppercase tracking-caps text-dim">What to bet</div>
        <div className="mt-1 text-base font-medium leading-6 text-fg">{instruction.action}</div>
        <div className="mt-0.5 text-2xs text-muted">
          On Polymarket, buy the side labelled{" "}
          <span className="font-medium text-fg">{instruction.clickLabel}</span>
        </div>

        <dl className="mt-2 space-y-1 border-t border-accent/20 pt-2 text-2xs leading-4">
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-positive">Wins if</dt>
            <dd className="min-w-0 text-muted">{instruction.winsIf}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-negative">Loses if</dt>
            <dd className="min-w-0 text-muted">{instruction.losesIf}</dd>
          </div>
        </dl>

        {!instruction.recognised ? (
          <p className="mt-2 text-2xs leading-4 text-warning">
            This market&apos;s wording was not one this app recognises, so the description above is
            generic — read the market text on Polymarket before buying.
          </p>
        ) : null}
      </div>

      {/* --- What a dollar does ---------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-line bg-elevated/40 px-3 py-2.5">
          <div className="text-2xs uppercase tracking-caps text-dim">
            If you stake {formatUsd(UNIT_STAKE)}
          </div>
          {unit === null ? (
            <p className="mt-1 text-xs text-dim">{UNAVAILABLE}</p>
          ) : (
            <>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="font-mono text-xl leading-none tabular-nums text-positive">
                  +{formatUsd(unit.profit)}
                </span>
                <span className="text-2xs text-muted">profit if it wins</span>
              </div>
              <div className="mt-1 text-2xs leading-4 text-muted">
                Buys{" "}
                <span className="font-mono tabular-nums text-fg">{unit.shares.toFixed(2)}</span>{" "}
                shares at{" "}
                <span className="font-mono tabular-nums text-fg">{formatCents(unit.price)}</span>,
                paying back{" "}
                <span className="font-mono tabular-nums text-fg">{formatUsd(unit.returned)}</span>.
                If it loses you get nothing back and are down{" "}
                <span className="font-mono tabular-nums text-negative">
                  {formatUsd(unit.lost)}
                </span>
                .
              </div>
              {atBankroll ? (
                <div className="mt-1.5 border-t border-line pt-1.5 text-2xs text-dim">
                  At your {formatUsd(bankroll)} bankroll setting:{" "}
                  <span className="font-mono tabular-nums text-fg">
                    +{formatUsd(atBankroll.profit)}
                  </span>{" "}
                  or −{formatUsd(atBankroll.lost)}.
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="rounded border border-line bg-elevated/40 px-3 py-2.5">
          <div className="text-2xs uppercase tracking-caps text-dim">Chance of hitting</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span
              className={cn(
                "font-mono text-xl leading-none tabular-nums",
                chanceTone(winProbability) === "positive"
                  ? "text-positive"
                  : chanceTone(winProbability) === "warning"
                    ? "text-warning"
                    : "text-fg",
              )}
            >
              {winPercent === null ? UNAVAILABLE : `${winPercent}%`}
            </span>
            {winPercent !== null ? (
              // Derived from the rounded win figure, not rounded separately, so the pair always
              // sums to 100. Rounding both independently showed "27%" beside "74%".
              <span className="text-2xs text-muted">so it loses {100 - winPercent}% of the time</span>
            ) : null}
          </div>
          <p className="mt-1 text-2xs leading-4 text-muted">
            This is the model&rsquo;s estimate, not a measured frequency. The profit above is what
            you get on the times it works, not an average — over many bets like this one, most
            individual bets at this price lose.
          </p>
        </div>
      </div>

      {/* --- Why it is here --------------------------------------------------- */}
      {why.length > 0 ? (
        <div>
          <div className="text-2xs uppercase tracking-caps text-dim">Why it is on this list</div>
          <ul className="mt-1 space-y-0.5">
            {why.map((reason) => (
              <li key={reason} className="flex gap-1.5 text-2xs leading-4 text-muted">
                <span aria-hidden="true" className="text-dim">
                  ·
                </span>
                <span className="min-w-0">{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="space-y-0.5">
          {warnings.map((warning) => (
            <li key={warning} className="text-2xs leading-4 text-warning">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}

      {/* --- The scoring vocabulary, last ------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-2xs text-dim">
          <span>
            Mid price{" "}
            <span className="font-mono tabular-nums text-muted">{formatCents(midPrice)}</span>, you
            pay{" "}
            <span className="font-mono tabular-nums text-fg">{formatCents(effectivePrice)}</span>
          </span>
          <span>
            Per day{" "}
            <span
              className={cn(
                "font-mono tabular-nums",
                returnPerDay !== null && returnPerDay > 0 ? "text-positive" : "text-muted",
              )}
            >
              {returnPerDay === null ? UNAVAILABLE : formatSignedPercent(returnPerDay, 2)}
            </span>
          </span>
          <span>
            Score{" "}
            <span
              className={cn(
                "font-mono tabular-nums",
                scoreTone(row.horizonScore) === "positive" ? "text-positive" : "text-fg",
              )}
            >
              {row.horizonScore === null ? UNAVAILABLE : Math.round(row.horizonScore)}
            </span>
          </span>
          <span>
            {row.qualifiedTraders} tracked trader{row.qualifiedTraders === 1 ? "" : "s"} on this side
          </span>
        </div>

        <div className="flex items-center gap-2">
          <LogBetButton opportunityId={row.id} stake={UNIT_STAKE} />
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
