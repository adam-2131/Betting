"use client";

/**
 * One click to record a bet.
 *
 * The friction here matters more than it looks. A log that is tedious to fill in gets filled in
 * selectively — and selectively means the winners, or the interesting ones, which produces a
 * record that is worse than none because it looks like evidence. One click, no form, no decisions.
 *
 * It records what you were offered, not confirmation that you placed anything. PolyAlpha still
 * never touches an order.
 */
import { useState, useTransition } from "react";
import { logBet, type LogBetResult } from "@/app/bets/actions";
import { cn } from "@/components/ui/primitives";

export function LogBetButton({
  opportunityId,
  stake = 1,
  className,
}: {
  opportunityId: string;
  stake?: number;
  className?: string;
}) {
  const [result, setResult] = useState<LogBetResult | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      setResult(await logBet(opportunityId, stake));
    });
  };

  if (result?.ok) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded border border-positive/40 bg-positive/10 px-2.5 py-1 text-2xs uppercase tracking-caps text-positive",
          className,
        )}
        title={result.message}
      >
        Logged at {(result.entryPrice * 100).toFixed(1)}¢
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        title="Records this bet so its price can be compared with the market's closing price later."
        className={cn(
          "rounded border px-2.5 py-1 text-2xs font-medium uppercase tracking-caps transition-colors",
          pending
            ? "border-line text-dim"
            : "border-line text-muted hover:border-accent/40 hover:text-accent",
          className,
        )}
      >
        {pending ? "Logging…" : "I bet this"}
      </button>
      {result && !result.ok ? (
        <span className="text-2xs text-negative">{result.message}</span>
      ) : null}
    </span>
  );
}
