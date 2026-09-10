"use client";

/**
 * Payout calculator.
 *
 * This computes numbers. It does not, and must not, place an order — including the ALL button,
 * which fills in the whole bankroll as a stake and calculates from it, nothing more. There is no
 * order-placement code anywhere in this application.
 *
 * All arithmetic comes from `@/lib/scoring/payout`, which is unit-tested, so the displayed
 * figures cannot diverge from the tested implementation.
 */
import { useMemo, useState } from "react";
import {
  bankrollExposure,
  calculatePayout,
  quickStakes,
} from "@/lib/scoring/payout";
import { formatNumber, formatPercent, formatSignedUsd, formatUsd, UNAVAILABLE } from "@/lib/num";
import { Card, CardHeader, KeyValue, cn } from "@/components/ui/primitives";

export function PayoutCalculator({
  price,
  bankroll,
  outcomeLabel,
}: {
  price: number | null;
  bankroll: number;
  outcomeLabel: string;
}) {
  const [stakeText, setStakeText] = useState("1.00");

  const stake = useMemo(() => {
    const parsed = Number.parseFloat(stakeText);
    return Number.isFinite(parsed) ? parsed : null;
  }, [stakeText]);

  const result = useMemo(() => calculatePayout(stake, price), [stake, price]);
  const presets = useMemo(() => quickStakes(bankroll), [bankroll]);

  const exposure = useMemo(
    () => bankrollExposure(stake ?? 0, bankroll).fractionOfBankroll,
    [stake, bankroll],
  );
  const heavy = exposure !== null && exposure >= 0.5;
  const total = exposure !== null && exposure >= 0.999;

  return (
    <Card>
      <CardHeader
        title="Payout calculator"
        subtitle="Calculates only. PolyAlpha never places, sizes or signs a trade."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-sm text-dim">
            $
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={0.25}
            value={stakeText}
            onChange={(event) => setStakeText(event.target.value)}
            aria-label="Stake in dollars"
            className="w-32 rounded border border-line bg-elevated py-1.5 pl-6 pr-2 font-mono text-sm tabular-nums text-fg outline-none focus:border-accent/60"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setStakeText(preset.amount.toFixed(2))}
              title={
                preset.label === "ALL"
                  ? "Fills in your whole bankroll and calculates the result. This does not place an order."
                  : undefined
              }
              className={cn(
                "rounded border px-2 py-1 font-mono text-2xs tabular-nums transition-colors",
                preset.label === "ALL"
                  ? "border-warning/40 text-warning hover:bg-warning/10"
                  : "border-line text-muted hover:border-accent/40 hover:text-accent",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {result.invalid ? (
        <p className="mt-3 text-2xs text-warning">{result.invalidReason}</p>
      ) : (
        <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
          <KeyValue label="Stake" value={formatUsd(result.stake)} />
          <KeyValue label="Entry price" value={`${(result.price * 100).toFixed(1)}¢`} />
          <KeyValue
            label="Shares"
            value={result.shares === null ? UNAVAILABLE : formatNumber(result.shares, 2)}
            hint="stake ÷ price"
          />
          <KeyValue
            label="Maximum payout if it wins"
            value={formatUsd(result.grossPayout)}
            tone="positive"
          />
          <KeyValue label="Profit if it wins" value={formatSignedUsd(result.profit)} tone="positive" />
          <KeyValue
            label="Loss if it loses"
            value={formatSignedUsd(result.lossIfWrong === 0 ? 0 : -result.lossIfWrong)}
            tone="negative"
          />
          <KeyValue label="Return if it wins" value={formatPercent(result.returnPct)} />
          <KeyValue
            label="Break-even probability"
            value={formatPercent(result.breakEvenProbability)}
            hint="How often this must win to break even"
          />
        </div>
      )}

      {exposure !== null && exposure > 0 ? (
        <div
          className={cn(
            "mt-3 rounded border px-3 py-2",
            total
              ? "border-negative/40 bg-negative/5"
              : heavy
                ? "border-warning/40 bg-warning/5"
                : "border-line bg-elevated/40",
          )}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-2xs uppercase tracking-caps text-muted">Share of bankroll</span>
            <span
              className={cn(
                "font-mono text-sm tabular-nums",
                total ? "text-negative" : heavy ? "text-warning" : "text-fg",
              )}
            >
              {formatPercent(exposure, 0)}
            </span>
          </div>
          <p className="mt-1 text-2xs leading-4 text-muted">
            {total ? (
              <>
                This is your entire {formatUsd(bankroll)} bankroll on one market. If it loses you
                have nothing left to work with.
              </>
            ) : heavy ? (
              <>
                This is {formatPercent(exposure, 0)} of your {formatUsd(bankroll)} bankroll on a
                single outcome.
              </>
            ) : (
              <>
                Of your {formatUsd(bankroll)} bankroll. Shown so you can see the consequence — it
                is not a recommendation of how much to stake.
              </>
            )}
          </p>
        </div>
      ) : null}

      <p className="mt-3 border-t border-line pt-3 text-2xs leading-4 text-dim">
        Payout is the maximum if {outcomeLabel} wins, and a larger payout means a less likely
        outcome, not a better opportunity. A 5¢ share pays 20× because the market thinks it will
        usually lose.
      </p>
    </Card>
  );
}
