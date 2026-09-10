"use client";

import { useActionState } from "react";
import { runBacktestAction, runSweepAction, type BacktestActionResult } from "./actions";
import { Card, CardHeader, cn } from "@/components/ui/primitives";

const inputClass =
  "w-full rounded border border-line bg-elevated px-2 py-1.5 font-mono text-sm tabular-nums text-fg outline-none focus:border-accent/60";

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="block py-2">
      <span className="text-xs text-fg">{label}</span>
      <span className="mt-0.5 block text-2xs leading-4 text-dim">{hint}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

export function SweepForm() {
  const [state, formAction, pending] = useActionState<BacktestActionResult | null, FormData>(
    runSweepAction,
    null,
  );

  return (
    <Card className="border-accent/25">
      <CardHeader
        title="Robustness sweep"
        subtitle="Runs the same analysis at six signal horizons and reports whether a finding survives. Start here — a single run cannot tell you whether its own result is a configuration artefact."
      />

      <form action={formAction}>
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Field label="Lookback (days)" hint="Applied identically to every horizon.">
            <input name="lookbackDays" type="number" min="7" max="720" defaultValue={365} className={inputClass} />
          </Field>
          <Field label="Market cap per horizon" hint="Runtime limit.">
            <input name="maxMarkets" type="number" min="10" max="4000" defaultValue={4000} className={inputClass} />
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-2xs font-medium uppercase tracking-caps text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {pending ? "Sweeping…" : "Run sweep"}
          </button>
          {pending ? (
            <span className="text-2xs text-dim">Six full backtests. Expect roughly half a minute.</span>
          ) : null}
          {state ? (
            <span className={cn("text-2xs", state.ok ? "text-positive" : "text-negative")}>
              {state.message}
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

export function BacktestForm() {
  const [state, formAction, pending] = useActionState<BacktestActionResult | null, FormData>(
    runBacktestAction,
    null,
  );

  return (
    <Card>
      <CardHeader
        title="Run a backtest"
        subtitle="Replays stored history and scores each past moment using only data that existed at that moment."
      />

      <form action={formAction}>
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Field
            label="Lookback (days)"
            hint="Only markets that resolved inside this window are tested."
          >
            <input name="lookbackDays" type="number" min="7" max="720" defaultValue={180} className={inputClass} />
          </Field>

          <Field
            label="Signal horizon (days before resolution)"
            hint="Fixed for every market so the evaluation moment is never chosen with hindsight."
          >
            <input name="horizonDays" type="number" min="1" max="90" defaultValue={7} className={inputClass} />
          </Field>

          <Field
            label="Minimum holders per side"
            hint="Sides with fewer reconstructed tracked holders are not scored."
          >
            <input name="minHolders" type="number" min="1" max="20" defaultValue={1} className={inputClass} />
          </Field>

          <Field label="Market cap" hint="Runtime limit. Oldest markets in the window are tested first.">
            <input name="maxMarkets" type="number" min="10" max="2000" defaultValue={600} className={inputClass} />
          </Field>

          <Field label="Label" hint="Optional, to tell runs apart.">
            <input
              name="label"
              type="text"
              maxLength={80}
              placeholder="e.g. 7-day horizon, 6 months"
              className={cn(inputClass, "font-sans")}
            />
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-2xs font-medium uppercase tracking-caps text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {pending ? "Running…" : "Run backtest"}
          </button>
          {pending ? (
            <span className="text-2xs text-dim">
              Rescoring every tracked trader at every historical date. This can take a minute.
            </span>
          ) : null}
          {state ? (
            <span className={cn("text-2xs", state.ok ? "text-positive" : "text-negative")}>
              {state.message}
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
