/**
 * The main unit of the product: one ranked opportunity.
 *
 * Everything shown here is either read from a stored row or derived by a pure function that is
 * unit-tested. Nothing is estimated for presentation, and any value we could not obtain renders
 * as "Unavailable" rather than as zero.
 */
import Link from "next/link";
import type { SignalType } from "@prisma/client";
import type { OpportunityRow } from "@/lib/queries/opportunities";
import {
  formatCents,
  formatNumber,
  formatPercent,
  formatSignedCents,
  formatTimeUntil,
  formatUsd,
  safeNumber,
  UNAVAILABLE,
} from "@/lib/num";
import { calculatePayout, payoutPerDollar } from "@/lib/scoring/payout";
import { describeOpportunity, type EntryVerdict } from "@/lib/plain-language";
import { Badge, Card, KeyValue, ProgressBar, cn, type Tone } from "@/components/ui/primitives";
import { SignalBadgeList } from "@/components/ui/signal-badge";
import { ViewOnPolymarket } from "@/components/ui/view-on-polymarket";

interface ReasonItem {
  text?: string;
}

function reasonList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : ((item as ReasonItem)?.text ?? "")))
    .filter((text): text is string => typeof text === "string" && text.length > 0);
}

function scoreTone(score: number | null): Tone {
  if (score === null) return "neutral";
  if (score >= 65) return "positive";
  if (score >= 45) return "accent";
  return "neutral";
}

function riskTone(risk: string | null): Tone {
  switch (risk?.toUpperCase()) {
    case "LOW":
      return "positive";
    case "HIGH":
    case "VERY HIGH":
      return "negative";
    case "MEDIUM":
      return "warning";
    default:
      return "neutral";
  }
}

const VERDICT_TONE: Record<EntryVerdict, Tone> = {
  BETTER_THAN_THEM: "positive",
  SIMILAR_ENTRY: "positive",
  PAYING_MORE: "warning",
  LATE: "negative",
  UNKNOWN: "neutral",
};

/**
 * The card in ordinary words, before any of the jargon below it.
 *
 * Everything here restates figures shown elsewhere on the card rather than adding new ones — the
 * point is comprehension, not extra information. See `src/lib/plain-language.ts` for the rules
 * these sentences follow.
 */
function InPlainEnglish({
  summary,
}: {
  summary: ReturnType<typeof describeOpportunity>;
}) {
  return (
    <div className="rounded border border-line bg-elevated/30 px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-2xs uppercase tracking-caps text-dim">In plain English</span>
        <Badge tone={VERDICT_TONE[summary.verdict]} size="sm">
          {summary.verdictLabel}
        </Badge>
      </div>
      <p className="text-xs leading-5 text-fg">{summary.headline}</p>
      {summary.entry ? (
        <p className="mt-1 text-2xs leading-4 text-muted">{summary.entry}</p>
      ) : null}
      {summary.stake ? (
        <p className="mt-1 text-2xs leading-4 text-muted">{summary.stake}</p>
      ) : null}
      <p className="mt-1.5 text-2xs leading-4 text-dim">{summary.action}</p>
    </div>
  );
}

/**
 * The entry gap is the single most important number for deciding whether a signal is still
 * actionable, so it gets its own treatment rather than sitting in the stat grid. A negative gap
 * means the current price is *below* the tracked entry, which is favourable.
 */
function EntryGap({ gap, eliteEntry }: { gap: number | null; eliteEntry: number | null }) {
  if (gap === null) {
    return (
      <div className="rounded border border-line bg-elevated/40 px-3 py-2">
        <div className="text-2xs uppercase tracking-caps text-muted">Entry gap</div>
        <div className="mt-0.5 text-sm text-dim">{UNAVAILABLE}</div>
        <p className="mt-1 text-2xs leading-4 text-dim">
          No tracked entry price for this side, so we cannot say whether the move has already
          happened.
        </p>
      </div>
    );
  }

  const cents = gap * 100;
  const good = cents <= 3;
  const poor = cents > 8;

  return (
    <div
      className={cn(
        "rounded border px-3 py-2",
        good && "border-positive/30 bg-positive/5",
        poor && "border-warning/30 bg-warning/5",
        !good && !poor && "border-line bg-elevated/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-2xs uppercase tracking-caps text-muted">Entry gap</span>
        <span
          className={cn(
            "font-mono text-sm tabular-nums",
            good && "text-positive",
            poor && "text-warning",
          )}
        >
          {formatSignedCents(gap)}
        </span>
      </div>
      <p className="mt-1 text-2xs leading-4 text-muted">
        {poor ? (
          <>
            <span className="font-medium text-warning">Poor entry — signal may be stale.</span>{" "}
            Tracked traders bought around {formatCents(eliteEntry)}, so most of the move they were
            positioning for has already happened.
          </>
        ) : good ? (
          <>
            Current price is close to the {formatCents(eliteEntry)} tracked traders paid, so the
            entry is broadly comparable to theirs.
          </>
        ) : (
          <>
            Tracked traders bought around {formatCents(eliteEntry)}. You would be paying more than
            they did.
          </>
        )}
      </p>
    </div>
  );
}

export function OpportunityCard({
  opportunity,
  rank,
  bankroll,
}: {
  opportunity: OpportunityRow;
  rank?: number;
  bankroll?: number;
}) {
  const { market } = opportunity;
  const price = safeNumber(opportunity.currentPrice);
  const score = safeNumber(opportunity.score);
  const outcomeLabel = market.outcomes[opportunity.outcomeIndex] ?? `Outcome ${opportunity.outcomeIndex}`;

  const perDollarResult = price !== null ? payoutPerDollar(price) : null;
  const perDollar =
    perDollarResult && !perDollarResult.invalid ? perDollarResult.grossPayout : null;

  // Illustrates the configured bankroll against this price. It describes what a stake would buy;
  // it is not a recommendation to stake it.
  const bankrollResult = bankroll !== undefined && price !== null ? calculatePayout(bankroll, price) : null;
  const bankrollExample =
    bankrollResult && !bankrollResult.invalid && bankrollResult.shares !== null
      ? {
          stake: bankrollResult.stake,
          shares: bankrollResult.shares,
          grossPayout: bankrollResult.grossPayout,
        }
      : null;
  const reasonsFor = reasonList(opportunity.reasonsFor);
  const reasonsAgainst = reasonList(opportunity.reasonsAgainst);

  const mid = safeNumber(opportunity.modelEstimateMid);
  const low = safeNumber(opportunity.modelEstimateLow);
  const high = safeNumber(opportunity.modelEstimateHigh);

  const plain = describeOpportunity({
    outcomeLabel,
    currentPrice: price,
    trackedEntry: safeNumber(opportunity.weightedEliteEntry),
    entryGap: safeNumber(opportunity.entryGap),
    qualifiedTraders: opportunity.qualifiedTraders,
    opposingTraders: opportunity.opposingTraders,
    bankroll,
  });

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            {rank !== undefined ? (
              <span className="font-mono text-2xs text-dim">#{rank}</span>
            ) : null}
            <Badge tone="neutral" size="sm">
              {market.category}
            </Badge>
            <Badge tone={outcomeLabel.toLowerCase() === "no" ? "negative" : "positive"} size="sm">
              {outcomeLabel.toUpperCase()}
            </Badge>
            {opportunity.riskLevel ? (
              <Badge tone={riskTone(opportunity.riskLevel)} size="sm">
                {opportunity.riskLevel} RISK
              </Badge>
            ) : null}
          </div>

          <Link
            href={`/opportunities/${opportunity.id}`}
            className="block text-sm font-medium leading-5 text-fg hover:text-accent"
          >
            {market.question}
          </Link>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-2xs uppercase tracking-caps text-muted">Score</div>
          <div
            className={cn(
              "font-mono text-3xl leading-none tabular-nums",
              score === null && "text-dim",
              scoreTone(score) === "positive" && "text-positive",
              scoreTone(score) === "accent" && "text-accent",
            )}
          >
            {score === null ? UNAVAILABLE : Math.round(score)}
          </div>
          <ProgressBar value={score} tone={scoreTone(score)} className="mt-1 w-24" />
        </div>
      </div>

      <InPlainEnglish summary={plain} />

      <SignalBadgeList
        signals={opportunity.signals.map((s) => ({ type: s.type as SignalType, detail: s.detail }))}
        size="sm"
      />

      <div className="grid grid-cols-2 gap-x-5 gap-y-0 sm:grid-cols-3 lg:grid-cols-4">
        <KeyValue label="Price" value={formatCents(price)} hint="Implied probability" />
        <KeyValue
          label="Payout per $1"
          value={perDollar === null ? UNAVAILABLE : `$${perDollar.toFixed(2)}`}
          hint="Max if this outcome wins"
        />
        <KeyValue
          label="Smart money"
          value={
            opportunity.consensusScore === null
              ? UNAVAILABLE
              : Math.round(opportunity.consensusScore)
          }
          hint="Consensus score"
        />
        <KeyValue
          label="Traders"
          value={opportunity.qualifiedTraders}
          hint={
            opportunity.opposingTraders > 0
              ? `${opportunity.opposingTraders} on the other side`
              : "Qualified holders"
          }
        />
        <KeyValue label="Tracked entry" value={formatCents(opportunity.weightedEliteEntry)} />
        <KeyValue label="Liquidity" value={formatUsd(market.liquidity)} />
        <KeyValue
          label="Spread"
          value={market.spread === null ? UNAVAILABLE : formatCents(market.spread, 1)}
        />
        <KeyValue label="Resolves" value={formatTimeUntil(market.endDate)} />
      </div>

      <EntryGap
        gap={safeNumber(opportunity.entryGap)}
        eliteEntry={safeNumber(opportunity.weightedEliteEntry)}
      />

      {mid !== null ? (
        <div className="rounded border border-line bg-elevated/40 px-3 py-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-2xs uppercase tracking-caps text-muted">Model estimate</span>
            <span className="font-mono text-sm tabular-nums text-fg">
              {formatPercent(mid, 0)}
              {low !== null && high !== null ? (
                <span className="ml-1 text-2xs text-dim">
                  ({formatPercent(low, 0)}–{formatPercent(high, 0)})
                </span>
              ) : null}
            </span>
          </div>
          <p className="mt-1 text-2xs leading-4 text-dim">
            Derived from smart-money signals, not from a forecast of the event. This is a model
            estimate, not a guaranteed edge.
          </p>
        </div>
      ) : null}

      {reasonsFor.length > 0 || reasonsAgainst.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {reasonsFor.length > 0 ? (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-caps text-positive">
                Why it is interesting
              </div>
              <ul className="space-y-1">
                {reasonsFor.slice(0, 4).map((text, i) => (
                  <li key={i} className="flex gap-1.5 text-2xs leading-4 text-muted">
                    <span className="text-positive">+</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {reasonsAgainst.length > 0 ? (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-caps text-warning">
                Why it could fail
              </div>
              <ul className="space-y-1">
                {reasonsAgainst.slice(0, 4).map((text, i) => (
                  <li key={i} className="flex gap-1.5 text-2xs leading-4 text-muted">
                    <span className="text-warning">−</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <div className="text-2xs text-dim">
          {bankrollExample ? (
            <>
              A {formatUsd(bankrollExample.stake)} stake would buy{" "}
              <span className="font-mono text-muted">
                {formatNumber(bankrollExample.shares, 1)}
              </span>{" "}
              shares, paying{" "}
              <span className="font-mono text-muted">
                {formatUsd(bankrollExample.grossPayout)}
              </span>{" "}
              if it wins.
            </>
          ) : (
            <>Volume {formatUsd(market.volume)}</>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/opportunities/${opportunity.id}`}
            className="rounded border border-line px-2.5 py-1 text-2xs uppercase tracking-caps text-muted transition-colors hover:border-accent/40 hover:text-accent"
          >
            Details
          </Link>
          <ViewOnPolymarket slug={market.slug} eventSlug={market.eventSlug} />
        </div>
      </div>
    </Card>
  );
}
