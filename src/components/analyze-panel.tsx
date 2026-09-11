"use client";

/**
 * The Analyze button and its results.
 *
 * Client-side because the whole point is that the reading is taken WHEN YOU ASK, moments before
 * deciding. Rendering it on page load would make it another cached snapshot, which is the thing it
 * exists to correct.
 *
 * Stop-level findings are hoisted above everything else and are the only thing on the panel styled
 * to interrupt. The board's ordering is untouched — a check that silently reorders results is a
 * check nobody can audit — so the flag has to carry the whole weight of the warning.
 */
import { useState, useTransition } from "react";
import { analyzeOpportunity, type AnalyzeResult } from "@/app/opportunities/[id]/analyze-action";
import type { Finding, FindingTone } from "@/lib/analysis/deep-dive";
import { formatCents, formatUsd } from "@/lib/num";
import { Card, CardHeader, cn } from "@/components/ui/primitives";

const TONE_STYLES: Record<FindingTone, { border: string; text: string; mark: string }> = {
  GOOD: { border: "border-positive/30 bg-positive/5", text: "text-positive", mark: "✓" },
  NEUTRAL: { border: "border-line bg-elevated/40", text: "text-muted", mark: "·" },
  WARNING: { border: "border-warning/40 bg-warning/5", text: "text-warning", mark: "!" },
  STOP: { border: "border-negative/50 bg-negative/10", text: "text-negative", mark: "✕" },
};

function FindingRow({ finding }: { finding: Finding }) {
  const style = TONE_STYLES[finding.tone];
  return (
    <div className={cn("rounded border px-3 py-2", style.border)}>
      <div className="flex gap-2">
        <span aria-hidden="true" className={cn("shrink-0 font-mono text-xs", style.text)}>
          {style.mark}
        </span>
        <div className="min-w-0">
          <div className={cn("text-xs font-medium leading-5", style.text)}>{finding.headline}</div>
          <p className="mt-0.5 text-2xs leading-4 text-muted">{finding.detail}</p>
        </div>
      </div>
    </div>
  );
}

export function AnalyzePanel({ opportunityId }: { opportunityId: string }) {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      setResult(await analyzeOpportunity(opportunityId));
    });
  };

  return (
    <Card>
      <CardHeader
        title="Check it against the live market"
        subtitle="Re-reads the order book, the event's other outcomes and the live trade tape. Everything above came from the last bulk sync."
        right={
          <button
            type="button"
            onClick={run}
            disabled={pending}
            className={cn(
              "rounded border px-3 py-1 text-2xs font-medium uppercase tracking-caps transition-colors",
              pending
                ? "border-line text-dim"
                : "border-accent/40 bg-accent/10 text-accent hover:border-accent/60 hover:bg-accent/20",
            )}
          >
            {pending ? "Checking…" : result ? "Check again" : "Analyze"}
          </button>
        }
      />

      {result === null ? (
        <p className="text-2xs leading-4 text-dim">
          Not yet checked. This costs a few live API calls, so it runs only when you ask — which is
          also the point, since a reading taken now is the only one that reflects the price you
          would actually get.
        </p>
      ) : !result.ok ? (
        <p className="text-2xs leading-4 text-negative">{result.message}</p>
      ) : (
        <AnalyzeResults result={result} />
      )}
    </Card>
  );
}

function AnalyzeResults({ result }: { result: Extract<AnalyzeResult, { ok: true }> }) {
  const { dive } = result;
  const rest = dive.findings.filter((f) => f.tone !== "STOP");
  const unitFill = dive.fills.find((f) => f.requestedUsd === 1);

  return (
    <div className="space-y-3">
      {dive.stops.length > 0 ? (
        <div className="space-y-2">
          <div className="text-2xs uppercase tracking-caps text-negative">
            Reasons not to take this
          </div>
          {dive.stops.map((finding) => (
            <FindingRow key={finding.key} finding={finding} />
          ))}
        </div>
      ) : (
        <div className="rounded border border-positive/30 bg-positive/5 px-3 py-2 text-xs text-positive">
          Nothing in the live market contradicts this row.
        </div>
      )}

      {/* The live numbers, so the reader can see what the checks were computed from. */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded border border-line bg-elevated/40 px-3 py-2.5 sm:grid-cols-4">
        <LiveStat
          label="Live fill, $1"
          value={unitFill?.averagePrice != null ? formatCents(unitFill.averagePrice) : "—"}
        />
        <LiveStat
          label="Resting at best ask"
          value={
            unitFill?.bestAskDepthUsd != null ? formatUsd(unitFill.bestAskDepthUsd) : "—"
          }
        />
        <LiveStat
          label="Edge at live price"
          value={
            dive.liveNetEdgePoints === null
              ? "—"
              : `${dive.liveNetEdgePoints > 0 ? "+" : ""}${dive.liveNetEdgePoints.toFixed(1)} pts`
          }
          tone={
            dive.liveNetEdgePoints !== null && dive.liveNetEdgePoints > 0 ? "positive" : "negative"
          }
        />
        <LiveStat
          label="Event house edge"
          value={
            dive.overround === null
              ? "not measurable"
              : `${(dive.overround.askOverroundPoints ?? dive.overround.midOverroundPoints).toFixed(1)} pts`
          }
        />
      </div>

      {rest.length > 0 ? (
        <div className="space-y-2">
          {rest.map((finding) => (
            <FindingRow key={finding.key} finding={finding} />
          ))}
        </div>
      ) : null}

      {dive.overround ? (
        <details className="rounded border border-line px-3 py-2">
          <summary className="cursor-pointer text-2xs uppercase tracking-caps text-muted">
            All {dive.overround.legCount} outcomes in this event
          </summary>
          <ul className="mt-2 space-y-0.5">
            {dive.overround.legs.map((leg) => (
              <li key={leg.id} className="flex justify-between gap-4 text-2xs text-muted">
                <span className="min-w-0 truncate">{leg.label}</span>
                <span className="shrink-0 font-mono tabular-nums text-fg">
                  {leg.mid === null ? "—" : formatCents(leg.mid)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {dive.errors.length > 0
        ? dive.errors.map((error) => (
            <p key={error} className="text-2xs leading-4 text-warning">
              {error}
            </p>
          ))
        : null}

      <p className="border-t border-line pt-2 text-2xs leading-4 text-dim">
        Read at {new Date(dive.checkedAt).toLocaleTimeString()}. These checks say whether the price
        is real and which way money is moving. None of them says who will win — that is what the
        market price already is.
      </p>
    </div>
  );
}

function LiveStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="min-w-0">
      <div className="text-2xs uppercase tracking-caps text-dim">{label}</div>
      <div
        className={cn(
          "mt-0.5 font-mono text-sm tabular-nums",
          tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-fg",
        )}
      >
        {value}
      </div>
    </div>
  );
}
